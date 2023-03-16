/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2022 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from 'vs/base/common/event';
import { Disposable, DisposableStore } from 'vs/base/common/lifecycle';
import { ILogService } from 'vs/platform/log/common/log';
import { ILanguageService } from 'vs/editor/common/languages/language';
import { InstantiationType, registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { IPositronEnvironmentInstance, IPositronEnvironmentService, PositronEnvironmentState } from 'vs/workbench/services/positronEnvironment/common/interfaces/positronEnvironmentService';
import { formatLanguageRuntime, ILanguageRuntime, ILanguageRuntimeService, RuntimeClientType, RuntimeOnlineState, RuntimeState } from 'vs/workbench/services/languageRuntime/common/languageRuntimeService';
import { EnvironmentClientMessageType, IEnvironmentClientInstance, IEnvironmentClientMessage, IEnvironmentClientMessageError, IEnvironmentClientMessageList, IEnvironmentVariable } from 'vs/workbench/services/languageRuntime/common/languageRuntimeEnvironmentClient';

/**
 * PositronEnvironmentService class.
 */
class PositronEnvironmentService extends Disposable implements IPositronEnvironmentService {
	//#region Private Properties

	/**
	 * A map of the Positron environment instances by language ID.
	 */
	private readonly _positronEnvironmentInstancesByLanguageId = new Map<string, PositronEnvironmentInstance>();

	/**
	 * A map of the Positron environment instances by runtime ID.
	 */
	private readonly _positronEnvironmentInstancesByRuntimeId = new Map<string, PositronEnvironmentInstance>();

	/**
	 * The active Positron environment instance.
	 */
	private _activePositronEnvironmentInstance?: IPositronEnvironmentInstance;

	/**
	 * The onDidStartPositronEnvironmentInstance event emitter.
	 */
	private readonly _onDidStartPositronEnvironmentInstanceEmitter = this._register(new Emitter<IPositronEnvironmentInstance>);

	/**
	 * The onDidChangeActivePositronEnvironmentInstance event emitter.
	 */
	private readonly _onDidChangeActivePositronEnvironmentInstanceEmitter = this._register(new Emitter<IPositronEnvironmentInstance | undefined>);

	//#endregion Private Properties

	//#region Constructor & Dispose

	/**
	 * Constructor.
	 * @param _languageRuntimeService The language runtime service.
	 * @param _languageService The language service.
	 * @param _logService The log service.
	 */
	constructor(
		@ILanguageRuntimeService private _languageRuntimeService: ILanguageRuntimeService,
		@ILanguageService _languageService: ILanguageService,
		@ILogService private _logService: ILogService,
	) {
		// Call the disposable constrcutor.
		super();

		// Start a Positron environment instance for each running runtime.
		this._languageRuntimeService.runningRuntimes.forEach(runtime => {
			this.startPositronEnvironmentInstance(runtime, false);
		});

		// Get the active runtime. If there is one, set the active Positron environment instance.
		if (this._languageRuntimeService.activeRuntime) {
			const positronEnvironmentInstance = this._positronEnvironmentInstancesByRuntimeId.get(this._languageRuntimeService.activeRuntime.metadata.runtimeId);
			if (positronEnvironmentInstance) {
				this.setActivePositronEnvironmentInstance(positronEnvironmentInstance);
			}
		}

		// Register the onWillStartRuntime event handler so we start a new Positron environment instance before a runtime starts up.
		this._register(this._languageRuntimeService.onWillStartRuntime(runtime => {
			const positronEnvironmentInstance = this._positronEnvironmentInstancesByLanguageId.get(runtime.metadata.languageId);
			if (positronEnvironmentInstance && positronEnvironmentInstance.state === PositronEnvironmentState.Exited) {
				positronEnvironmentInstance.setRuntime(runtime, true);
				this._positronEnvironmentInstancesByRuntimeId.delete(positronEnvironmentInstance.runtime.metadata.runtimeId);
				this._positronEnvironmentInstancesByRuntimeId.set(positronEnvironmentInstance.runtime.metadata.runtimeId, positronEnvironmentInstance);
			} else {
				this.startPositronEnvironmentInstance(runtime, true);
			}
		}));

		// Register the onDidStartRuntime event handler so we activate the new Positron environment instance when the runtime starts up.
		this._register(this._languageRuntimeService.onDidStartRuntime(runtime => {
			const positronEnvironmentInstance = this._positronEnvironmentInstancesByRuntimeId.get(runtime.metadata.runtimeId);
			if (positronEnvironmentInstance) {
				positronEnvironmentInstance.setState(PositronEnvironmentState.Ready);
			}
		}));

		// Register the onDidFailStartRuntime event handler so we activate the new Positron environment instance when the runtime starts up.
		this._register(this._languageRuntimeService.onDidFailStartRuntime(runtime => {
			const positronEnvironmentInstance = this._positronEnvironmentInstancesByRuntimeId.get(runtime.metadata.runtimeId);
			if (positronEnvironmentInstance) {
				positronEnvironmentInstance.setState(PositronEnvironmentState.Exited);
			}
		}));

		// Register the onDidReconnectRuntime event handler so we start a new Positron environment instance when a runtime is reconnected.
		this._register(this._languageRuntimeService.onDidReconnectRuntime(runtime => {
			this.startPositronEnvironmentInstance(runtime, false);
		}));

		// Register the onDidChangeRuntimeState event handler so we can activate the REPL for the active runtime.
		this._register(this._languageRuntimeService.onDidChangeRuntimeState(languageRuntimeStateEvent => {
			const positronEnvironmentInstance = this._positronEnvironmentInstancesByRuntimeId.get(languageRuntimeStateEvent.runtime_id);
			if (!positronEnvironmentInstance) {
				// TODO@softwarenerd... Handle this in some special way.
				return;
			}

			switch (languageRuntimeStateEvent.new_state) {
				case RuntimeState.Uninitialized:
				case RuntimeState.Initializing:
					break;

				case RuntimeState.Starting:
					positronEnvironmentInstance.setState(PositronEnvironmentState.Starting);
					break;

				case RuntimeState.Ready:
					positronEnvironmentInstance.setState(PositronEnvironmentState.Ready);
					break;

				case RuntimeState.Offline:
					positronEnvironmentInstance.setState(PositronEnvironmentState.Offline);
					break;

				case RuntimeState.Exiting:
					positronEnvironmentInstance.setState(PositronEnvironmentState.Exiting);
					break;

				case RuntimeState.Exited:
					positronEnvironmentInstance.setState(PositronEnvironmentState.Exited);
					break;
			}
		}));

		// Register the onDidChangeActiveRuntime event handler so we can activate the REPL for the active runtime.
		this._register(this._languageRuntimeService.onDidChangeActiveRuntime(runtime => {
			if (!runtime) {
				this.setActivePositronEnvironmentInstance();
			} else {
				const positronEnvironmentInstance = this._positronEnvironmentInstancesByRuntimeId.get(runtime.metadata.runtimeId);
				if (positronEnvironmentInstance) {
					this.setActivePositronEnvironmentInstance(positronEnvironmentInstance);
				} else {
					this._logService.error(`Language runtime ${formatLanguageRuntime(runtime)} became active, but a REPL instance for it is not running.`);
				}
			}
		}));
	}

	//#endregion Constructor & Dispose

	//#region IPositronEnvironmentService Implementation

	// Needed for service branding in dependency injector.
	declare readonly _serviceBrand: undefined;

	// An event that is fired when a REPL instance is started.
	readonly onDidStartPositronEnvironmentInstance = this._onDidStartPositronEnvironmentInstanceEmitter.event;

	// An event that is fired when the active REPL instance changes.
	readonly onDidChangeActivePositronEnvironmentInstance = this._onDidChangeActivePositronEnvironmentInstanceEmitter.event;

	// Gets the repl instances.
	get positronEnvironmentInstances(): IPositronEnvironmentInstance[] {
		return Array.from(this._positronEnvironmentInstancesByRuntimeId.values());
	}

	// Gets the active REPL instance.
	get activePositronEnvironmentInstance(): IPositronEnvironmentInstance | undefined {
		return this._activePositronEnvironmentInstance;
	}

	/**
	 * Placeholder that gets called to "initialize" the PositronEnvironmentService.
	 */
	initialize() {
	}

	//#endregion IPositronEnvironmentService Implementation

	//#region Private Methods

	/**
	 * Starts a Positron environment instance for the specified runtime.
	 * @param runtime The runtime for the new Positron environment instance.
	 * @param starting A value which indicates whether the runtime is starting.
	 * @returns The new Positron environment instance.
	 */
	private startPositronEnvironmentInstance(runtime: ILanguageRuntime, starting: boolean): IPositronEnvironmentInstance {
		// Create the new Positron environment instance.
		const positronEnvironmentInstance = new PositronEnvironmentInstance(runtime, starting);

		// Add the Positron environment instance.
		this._positronEnvironmentInstancesByLanguageId.set(runtime.metadata.languageId, positronEnvironmentInstance);
		this._positronEnvironmentInstancesByRuntimeId.set(runtime.metadata.runtimeId, positronEnvironmentInstance);

		// Fire the onDidStartPositronEnvironmentInstance event.
		this._onDidStartPositronEnvironmentInstanceEmitter.fire(positronEnvironmentInstance);

		// Set the active positron environment instance.
		this._activePositronEnvironmentInstance = positronEnvironmentInstance;

		// Fire the onDidChangeActivePositronEnvironmentInstance event.
		this._onDidChangeActivePositronEnvironmentInstanceEmitter.fire(positronEnvironmentInstance);

		// Return the instance.
		return positronEnvironmentInstance;
	}

	/**
	 * Sets the active Positron environment instance.
	 * @param positronEnvironmentInstance
	 */
	private setActivePositronEnvironmentInstance(positronEnvironmentInstance?: IPositronEnvironmentInstance) {
		// Set the active instance and fire the onDidChangeActivePositronEnvironmentInstance event.
		this._activePositronEnvironmentInstance = positronEnvironmentInstance;
		this._onDidChangeActivePositronEnvironmentInstanceEmitter.fire(positronEnvironmentInstance);
	}

	//#endregion Private Methods
}

/**
 * PositronEnvironmentInstance class.
 */
class PositronEnvironmentInstance extends Disposable implements IPositronEnvironmentInstance {
	//#region Private Properties

	/**
	 * Gets or sets the runtime.
	 */
	private _runtime: ILanguageRuntime;

	/**
	 * Gets or sets the runtime disposable store. This contains things that are disposed when a
	 * runtime is detached.
	 */
	private _runtimeDisposableStore = new DisposableStore();

	/**
	 * Gets or sets the state.
	 */
	private _state = PositronEnvironmentState.Uninitialized;

	/**
	 * Gets or sets the environment client that is used to communicate with the language runtime.
	 */
	private _runtimeClient?: IEnvironmentClientInstance;

	/**
	 * The onDidChangeState event emitter.
	 */
	private readonly _onDidChangeStateEmitter = this._register(new Emitter<PositronEnvironmentState>);

	//#endregion Private Properties

	//#region Constructor & Dispose

	/**
	 * Constructor.
	 * @param runtime The language runtime.
	 * @param starting A value which indicates whether the Positron environment instance is starting.
	 */
	constructor(runtime: ILanguageRuntime, starting: boolean) {
		// Call the base class's constructor.
		super();

		// Set the runtime.
		this._runtime = runtime;

		// Attach to the runtime.
		this.attachRuntime(starting);
	}

	/**
	 * Disposes of the PositronEnvironmentInstance.
	 */
	override dispose(): void {
		// Call Disposable's dispose.
		super.dispose();

		// Dispose of the runtime event handlers.
		this._runtimeDisposableStore.dispose();
	}

	//#endregion Constructor & Dispose

	//#region IPositronEnvironmentInstance Implementation

	/**
	 * Gets the runtime.
	 */
	get runtime(): ILanguageRuntime {
		return this._runtime;
	}

	/**
	 * Gets the state.
	 */
	get state(): PositronEnvironmentState {
		return this._state;
	}

	/**
	 * onDidChangeState event.
	 */
	readonly onDidChangeState: Event<PositronEnvironmentState> = this._onDidChangeStateEmitter.event;

	//#endregion IPositronEnvironmentInstance Implementation

	//#region Public Methods

	/**
	 * Sets the runtime.
	 * @param runtime The runtime.
	 * @param starting A value which indicates whether the runtime is starting.
	 */
	setRuntime(runtime: ILanguageRuntime, starting: boolean) {
		// Set the runtime.
		this._runtime = runtime;

		// Attach the runtime.
		this.attachRuntime(starting);
	}

	/**
	 * Sets the state.
	 * @param state The new state.
	 */
	setState(state: PositronEnvironmentState) {
		switch (state) {
			case PositronEnvironmentState.Uninitialized:
			case PositronEnvironmentState.Starting:
				break;

			case PositronEnvironmentState.Ready:
				break;

			case PositronEnvironmentState.Offline:
				break;
		}

		// Set the new state and raise the onDidChangeState event.
		this._state = state;
		this._onDidChangeStateEmitter.fire(this._state);
	}

	//#endregion Public Methods

	//#region Private Methods

	/**
	 * Attaches to a runtime.
	 * @param starting A value which indicates whether the runtime is starting.
	 */
	private async attachRuntime(starting: boolean) {
		// Add the appropriate runtime item to indicate whether the Positron console instance is
		// is starting or is reconnected.
		if (starting) {
			this.setState(PositronEnvironmentState.Starting);
		} else {
			this.setState(PositronEnvironmentState.Ready);
		}

		// Add the onDidChangeRuntimeState event handler.
		this._runtimeDisposableStore.add(
			this._runtime.onDidChangeRuntimeState(runtimeState => {
				if (runtimeState === RuntimeState.Exited) {
					this.detachRuntime();
				}
			})
		);

		// Add the onDidCompleteStartup event handler.
		this._runtimeDisposableStore.add(
			this._runtime.onDidCompleteStartup(async languageRuntimeInfo => {
				await this.createRuntimeClient();
			})
		);

		// Add the onDidReceiveRuntimeMessageState event handler.
		this._runtimeDisposableStore.add(
			this._runtime.onDidReceiveRuntimeMessageState(languageRuntimeMessageState => {
				switch (languageRuntimeMessageState.state) {
					case RuntimeOnlineState.Starting: {
						break;
					}

					case RuntimeOnlineState.Busy: {
						this.setState(PositronEnvironmentState.Busy);
						break;
					}

					case RuntimeOnlineState.Idle: {
						this.setState(PositronEnvironmentState.Ready);
						break;
					}
				}
			})
		);

		// Add the onDidReceiveRuntimeMessageEvent event handler.
		this._runtimeDisposableStore.add(
			this._runtime.onDidReceiveRuntimeMessageEvent(languageRuntimeMessageEvent => {
			})
		);
	}

	/**
	 * Detaches from a runtime.
	 */
	private detachRuntime() {
		this._runtimeClient = undefined;
		this._runtimeDisposableStore.dispose();
		this._runtimeDisposableStore = new DisposableStore();
	}

	/**
	 * Creates the runtime client.
	 */
	private async createRuntimeClient() {
		// Try to create the runtime client.
		try {
			// Create the runtime client.
			this._runtimeClient = await this._runtime.createClient<IEnvironmentClientMessage>(
				RuntimeClientType.Environment,
				{}
			);
			if (!this._runtimeClient) {
				console.log('FAILURE');
				return;
			}

			// Add the onDidChangeClientState event handler.
			this._runtimeDisposableStore.add(
				this._runtimeClient.onDidChangeClientState(_clientState => {
					// TODO: Handle client state changes here.
				})
			);

			// Add the onDidReceiveData event handler.
			this._runtimeDisposableStore.add(
				this._runtimeClient.onDidReceiveData((msg: IEnvironmentClientMessage) => {
					if (msg.msg_type === EnvironmentClientMessageType.List) {
						this.processListMessage(msg as IEnvironmentClientMessageList);
					} else if (msg.msg_type === EnvironmentClientMessageType.Error) {
						this.processErrorMessage(msg as IEnvironmentClientMessageError);
					}
				})
			);

			// Add the runtime client to the runtime disposable store.
			this._runtimeDisposableStore.add(this._runtimeClient);
		} catch (error) {
			console.log('FAILURE');
			console.log(error);
		}
	}

	/**
	 * Processes an IEnvironmentClientMessageList.
	 * @param environmentClientMessageList The IEnvironmentClientMessageList.
	 */
	private processListMessage(environmentClientMessageList: IEnvironmentClientMessageList) {
		// Clear out the existing environment entries since this list
		// completely replaces them.
		//this.clearEnvironment(true);

		// Add the new environment entries.
		for (let i = 0; i < environmentClientMessageList.variables.length; i++) {
			const variable: IEnvironmentVariable = environmentClientMessageList.variables[i];
			console.log(variable);

			// TODO: Handle the case where the variable is something
			// other than a String.
			//this.setEnvironmentDataEntry(new EnvironmentValueEntry(variable.name, new StringEnvironmentValue(variable.value)));
		}

	}

	/**
	 * Processes an IEnvironmentClientMessageError.
	 * @param environmentClientMessageError The IEnvironmentClientMessageError.
	 */
	private processErrorMessage(environmentClientMessageError: IEnvironmentClientMessageError) {
		console.error(environmentClientMessageError.message);
	}

	//#endregion Private Methods
}

// Register the Positron environment service.
registerSingleton(IPositronEnvironmentService, PositronEnvironmentService, InstantiationType.Delayed);
