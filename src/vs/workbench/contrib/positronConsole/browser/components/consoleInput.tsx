/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2023 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./consoleInput';
import * as React from 'react';
import { forwardRef, useCallback, useEffect, useRef } from 'react'; // eslint-disable-line no-duplicate-imports
import { URI } from 'vs/base/common/uri';
import { Schemas } from 'vs/base/common/network';
import { KeyCode } from 'vs/base/common/keyCodes';
import { generateUuid } from 'vs/base/common/uuid';
import { DisposableStore } from 'vs/base/common/lifecycle';
import { HistoryNavigator2 } from 'vs/base/common/history';
import { IKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { useStateRef } from 'vs/base/browser/ui/react/useStateRef';
import { IEditorOptions } from 'vs/editor/common/config/editorOptions';
import { IFocusReceiver } from 'vs/base/browser/positronReactRenderer';
import { CodeEditorWidget } from 'vs/editor/browser/widget/codeEditorWidget';
import { ModesHoverController } from 'vs/editor/contrib/hover/browser/hover';
import { EditorExtensionsRegistry } from 'vs/editor/browser/editorExtensions';
import { MarkerController } from 'vs/editor/contrib/gotoError/browser/gotoError';
import { SuggestController } from 'vs/editor/contrib/suggest/browser/suggestController';
import { SnippetController2 } from 'vs/editor/contrib/snippet/browser/snippetController2';
import { ContextMenuController } from 'vs/editor/contrib/contextmenu/browser/contextmenu';
import { TabCompletionController } from 'vs/workbench/contrib/snippets/browser/tabCompletion';
import { IInputHistoryEntry } from 'vs/workbench/contrib/executionHistory/common/executionHistoryService';
import { SelectionClipboardContributionID } from 'vs/workbench/contrib/codeEditor/browser/selectionClipboard';
import { usePositronConsoleContext } from 'vs/workbench/contrib/positronConsole/browser/positronConsoleContext';
import { RuntimeCodeFragmentStatus } from 'vs/workbench/services/languageRuntime/common/languageRuntimeService';
import { IPositronConsoleInstance, PositronConsoleState } from 'vs/workbench/services/positronConsole/common/interfaces/positronConsoleService';

// ConsoleInputProps interface.
export interface ConsoleInputProps {
	readonly width: number;
	readonly hidden: boolean;
	readonly focusReceiver: IFocusReceiver;
	readonly executeCode: (codeFragment: string) => void;
	readonly positronConsoleInstance: IPositronConsoleInstance;
}

/**
 * ConsoleInput component.
 * @param props A ConsoleInputProps that contains the component properties.
 * @returns The rendered component.
 */
export const ConsoleInput = forwardRef<HTMLDivElement, ConsoleInputProps>((props: ConsoleInputProps, ref) => {
	// Context hooks.
	const positronConsoleContext = usePositronConsoleContext();

	// Reference hooks.
	const refContainer = useRef<HTMLDivElement>(undefined!);

	// State hooks.
	const [, setCodeEditorWidget, refCodeEditorWidget] = useStateRef<CodeEditorWidget>(undefined!);
	const [, setCodeEditorWidth, refCodeEditorWidth] = useStateRef(props.width);
	const [, setHistoryNavigator, refHistoryNavigator] =
		useStateRef<HistoryNavigator2<IInputHistoryEntry> | undefined>(undefined);
	const [, setCurrentCodeFragment, refCurrentCodeFragment] =
		useStateRef<string | undefined>(undefined);

	/**
	 * Updates the code editor widget position such that the cursor appers on
	 * the last line and the last column.
	 */
	const updateCodeEditorWidgetPositionToEnd = () => {
		// Get the model. If it isn't null (which it won't be), set the code editor widget
		// position.
		const textModel = refCodeEditorWidget.current.getModel();
		if (textModel) {
			const lineNumber = textModel.getLineCount();
			refCodeEditorWidget.current.setPosition({
				lineNumber,
				column: textModel.getLineContent(lineNumber).length + 1
			});

			// Ensure that the code editor widget is scrolled into view.
			refContainer.current?.scrollIntoView({ behavior: 'auto' });
		}
	};

	// Memoize the key down event handler.
	const keyDownHandler = useCallback(async (e: IKeyboardEvent) => {

		// Check for a suggest widget in the DOM. If one exists, then don't
		// handle the key.
		//
		// TODO(Kevin): Ideally, we'd do this by checking the
		// 'suggestWidgetVisible' context key, but the way VSCode handles
		// 'scoped' contexts makes that challenging to access here, and I
		// haven't figured out the 'right' way to get access to those contexts.
		const suggestWidgets = document.getElementsByClassName('suggest-widget');
		for (const suggestWidget of suggestWidgets) {
			if (suggestWidget.classList.contains('visible')) {
				return;
			}
		}

		/**
		 * Consumes an event.
		 */
		const consumeEvent = () => {
			e.preventDefault();
			e.stopPropagation();
		};

		// Process the key code.
		switch (e.keyCode) {
			// Escape handling.
			case KeyCode.Escape: {
				// Interrupt the runtime.
				props.positronConsoleInstance.runtime.interrupt();

				// Consume the event.
				consumeEvent();
				break;
			}

			// Ctrl-C handling.
			case KeyCode.KeyC: {
				// Check for the right modifiers and if this is a Ctrl-C, interrupt the runtime.
				if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && !e.altGraphKey) {
					// Interrupt the runtime.
					props.positronConsoleInstance.runtime.interrupt();

					// Consume the event.
					consumeEvent();
				}
				break;
			}

			// Up arrow processing.
			case KeyCode.UpArrow: {
				// If the console instance isn't ready, ignore the event.
				if (props.positronConsoleInstance.state !== PositronConsoleState.Ready) {
					consumeEvent();
					return;
				}

				// If there are history entries, process the event.
				if (refHistoryNavigator.current) {
					// When the user moves up from the end, and we don't have a current code editor
					// fragment, set the current code fragment. Otherwise, move to the previous
					// entry.
					if (refHistoryNavigator.current.isAtEnd() &&
						refCurrentCodeFragment.current === undefined) {
						setCurrentCodeFragment(refCodeEditorWidget.current.getValue());
					} else {
						refHistoryNavigator.current.previous();
					}

					// Get the current history entry, set it as the value of the code editor widget.
					const inputHistoryEntry = refHistoryNavigator.current.current();
					refCodeEditorWidget.current.setValue(inputHistoryEntry.input);

					// Position the cursor to the end.
					updateCodeEditorWidgetPositionToEnd();
				}

				// Consume the event.
				consumeEvent();
				break;
			}

			// Down arrow processing.
			case KeyCode.DownArrow: {
				// If the console instance isn't ready, ignore the event.
				if (props.positronConsoleInstance.state !== PositronConsoleState.Ready) {
					consumeEvent();
					return;
				}

				// If there are history entries, process the event.
				if (refHistoryNavigator.current) {
					// When the user reaches the end of the history entries, restore the current
					// code fragment.
					if (refHistoryNavigator.current.isAtEnd()) {
						if (refCurrentCodeFragment.current !== undefined) {
							refCodeEditorWidget.current.setValue(refCurrentCodeFragment.current);
							setCurrentCodeFragment(undefined);
						}
					} else {
						// Move to the next history entry and set it as the value of the code editor
						// widget.
						const inputHistoryEntry = refHistoryNavigator.current.next();
						refCodeEditorWidget.current.setValue(inputHistoryEntry.input);
					}

					// Position the cursor to the end.
					updateCodeEditorWidgetPositionToEnd();
				}

				// Consume the event.
				consumeEvent();
				break;
			}

			// Enter processing.
			case KeyCode.Enter: {
				// If the console instance isn't ready, ignore the event.
				if (props.positronConsoleInstance.state !== PositronConsoleState.Ready) {
					consumeEvent();
					return;
				}

				// If the shift key is pressed, do not process the event because the user is
				// entering multiple lines.
				if (e.shiftKey) {
					return;
				}

				// Get the code fragment from the editor.
				const codeFragment = refCodeEditorWidget.current.getValue();

				// Check on whether the code fragment is complete and can be executed.
				let executeCode;
				const runtimeCodeFragmentStatus = await props.
					positronConsoleInstance.
					runtime.
					isCodeFragmentComplete(codeFragment);

				// Handle the runtime code fragment status.
				switch (runtimeCodeFragmentStatus) {
					// If the code fragment is complete, execute it.
					case RuntimeCodeFragmentStatus.Complete:
						executeCode = true;
						break;

					// If the code fragment is incomplete, don't do anything. The user will just see
					// a new line in the input area.
					case RuntimeCodeFragmentStatus.Incomplete:
						executeCode = false;
						break;

					// If the code is invalid (contains syntax errors), warn but execute it anyway
					// (so the user can see a syntax error from the interpreter).
					case RuntimeCodeFragmentStatus.Invalid:
						positronConsoleContext.logService.warn(`Executing invalid code fragment: '${codeFragment}'`);
						executeCode = true;
						break;

					// If the code is invalid (contains syntax errors), warn but execute it anyway
					// (so the user can see a syntax error from the interpreter).
					case RuntimeCodeFragmentStatus.Unknown:
						positronConsoleContext.logService.warn(`Could not determine whether code fragment: '${codeFragment}' is complete.`);
						executeCode = true;
						break;
				}

				// If we're supposed to execute the code fragment, do it.
				if (executeCode) {
					// Execute the code fragment.
					props.executeCode(codeFragment);

					// If the code fragment contains more than whitespace characters, add it to the
					// history navigator.
					if (codeFragment.trim().length) {
						// Create the input history entry.
						const inputHistoryEntry = {
							when: new Date().getTime(),
							input: codeFragment,
						} satisfies IInputHistoryEntry;

						// Add the input history entry.
						if (refHistoryNavigator.current) {
							refHistoryNavigator.current.add(inputHistoryEntry);
						} else {
							// TODO@softwarenerd - Get 1000 from settings.
							setHistoryNavigator(new HistoryNavigator2<IInputHistoryEntry>(
								[inputHistoryEntry], 1000
							));
						}
					}

					// Reset the model for the next input.
					setCurrentCodeFragment(undefined);
					refCodeEditorWidget.current.setValue('');
				}

				// Consume the event.
				consumeEvent();
				break;
			}
		}
	}, []);

	// Main useEffect.
	useEffect(() => {
		// Create the disposable store for cleanup.
		const disposableStore = new DisposableStore();

		// Build the history entries, if there is input history.
		const inputHistoryEntries = positronConsoleContext.
			executionHistoryService.
			getInputEntries(props.positronConsoleInstance.runtime.metadata.languageId);
		if (inputHistoryEntries.length) {
			console.log(`There are input history entries for ${props.positronConsoleInstance.runtime.metadata.languageId}`);
			inputHistoryEntries.forEach((inputHistoryEntry, index) => {
				console.log(`    Entry: ${index} Code: ${inputHistoryEntry.input}`);
			});
			// TODO@softwarenerd - Get 1000 from settings.
			setHistoryNavigator(new HistoryNavigator2<IInputHistoryEntry>(inputHistoryEntries.slice(-1000), 1000));
		}

		// Create the resource URI.
		const uri = URI.from({
			scheme: Schemas.inMemory,
			path: `/repl-${props.positronConsoleInstance.runtime.metadata.languageId}-${generateUuid()}`
		});

		// Create language selection.
		const languageSelection = positronConsoleContext.
			languageService.
			createById(props.positronConsoleInstance.runtime.metadata.languageId);

		// Create text model; this is the backing store for the Monaco editor that receives
		// the user's input.
		const textModel = positronConsoleContext.modelService.createModel(
			'',					// initial value
			languageSelection,  // language selection
			uri,          		// resource URI
			false               // this widget is not simple
		);

		// Line numbers functions.
		const notReadyLineNumbers = (n: number) => '';
		const readyLineNumbers = (n: number) => {
			// Render the input prompt for the first line; do not render
			// anything in the margin for following lines
			if (n < 2) {
				return props.positronConsoleInstance.runtime.metadata.inputPrompt;
			}
			return '';
		};

		// The editor options we override.
		const editorOptions = {
			lineNumbers: readyLineNumbers,
			readOnly: true,
			minimap: {
				enabled: false
			},
			glyphMargin: false,
			folding: false,
			lineDecorationsWidth: '1.0ch',
			renderLineHighlight: 'none',
			wordWrap: 'bounded',
			wordWrapColumn: 2048,
			scrollbar: {
				vertical: 'hidden',
				useShadows: false
			},
			overviewRulerLanes: 0,
			scrollBeyondLastLine: false,
			lineNumbersMinChars: props.positronConsoleInstance.runtime.metadata.inputPrompt.length
		} satisfies IEditorOptions;

		// Create the code editor widget.
		const codeEditorWidget = positronConsoleContext.instantiationService.createInstance(
			CodeEditorWidget,
			refContainer.current,
			{
				...positronConsoleContext.configurationService.getValue<IEditorOptions>('editor'),
				...editorOptions
			},
			{
				isSimpleWidget: false,
				contributions: EditorExtensionsRegistry.getSomeEditorContributions([
					SelectionClipboardContributionID,
					ContextMenuController.ID,
					SuggestController.ID,
					SnippetController2.ID,
					TabCompletionController.ID,
					ModesHoverController.ID,
					MarkerController.ID,
				])
			});

		// Add the code editor widget to the disposables store.
		disposableStore.add(codeEditorWidget);
		setCodeEditorWidget(codeEditorWidget);

		// Attach the text model.
		codeEditorWidget.setModel(textModel);

		// Set the key down handler.
		codeEditorWidget.onKeyDown(keyDownHandler);

		// Auto-grow the editor as the internal content size changes (i.e. make
		// it grow vertically as the user enters additional lines of input)
		codeEditorWidget.onDidContentSizeChange(contentSizeChangedEvent => {
			codeEditorWidget.layout({
				width: refCodeEditorWidth.current,
				height: codeEditorWidget.getContentHeight()
			});
		});

		// Forward mouse wheel events. We do this because it is not currently
		// possible to prevent the editor from trapping scroll events, so
		// instead we use this handle to forward the scroll events to the outer
		// scrollable region (consisting of all REPL cells)
		// this.onMouseWheel = this._editor.onMouseWheel;

		// Perform the initial layout.
		codeEditorWidget.layout();

		// Add the onDidChangeConfiguration event handler.
		disposableStore.add(
			positronConsoleContext.configurationService.onDidChangeConfiguration(configurationChangeEvent => {
				if (configurationChangeEvent.affectsConfiguration('editor')) {
					codeEditorWidget.updateOptions({
						...positronConsoleContext.configurationService.getValue<IEditorOptions>('editor'),
						...editorOptions
					});
				}
			})
		);

		// Add the onDidClearConsole event handler.
		disposableStore.add(props.positronConsoleInstance.onDidClearConsole(() => {
			// When the console is cleared, erase anything that was partially entered.
			textModel.setValue('');

			// Re-focus the console.
			codeEditorWidget.focus();
		}));

		// Add the onDidClearConsole event handler.
		disposableStore.add(props.positronConsoleInstance.onDidChangeState(state => {
			// Set up editor options based on state.
			let lineNumbers;
			let readOnly;
			switch (state) {
				// When uninitialized or starting, switch to a read only normal prompt so it looks
				// right, but no typeahead is allowed.
				case PositronConsoleState.Uninitialized:
				case PositronConsoleState.Starting:
					readOnly = true;
					lineNumbers = readyLineNumbers;
					break;

				// When ready, switch to an active normal prompt.
				case PositronConsoleState.Ready:
					readOnly = false;
					lineNumbers = readyLineNumbers;
					break;

				// In any other state, don't display the normal prompt, but allow typeahead.
				default:
					readOnly = false;
					lineNumbers = notReadyLineNumbers;
			}

			// Update the code editor widget options.
			codeEditorWidget.updateOptions({
				...editorOptions,
				readOnly,
				lineNumbers
			});
		}));

		// Add the onDidClearConsole event handler.
		disposableStore.add(props.positronConsoleInstance.onDidClearConsole(() => {
			// When the console is cleared, erase anything that was partially entered.
			textModel.setValue('');

			// Re-focus the console.
			codeEditorWidget.focus();
		}));

		// Add the onDidClearInputHistory event handler.
		disposableStore.add(props.positronConsoleInstance.onDidClearInputHistory(() => {
			// Discard the history navigator.
			setHistoryNavigator(undefined);

			// Re-focus the console.
			codeEditorWidget.focus();
		}));

		// Add the onFocused event handler.
		disposableStore.add(props.focusReceiver.onFocused(() => {
			if (!props.hidden) {
				codeEditorWidget.focus();
			}
		}));

		// Focus the console.
		codeEditorWidget.focus();

		// Return the cleanup function that will dispose of the disposables.
		return () => disposableStore.dispose();
	}, []);

	// Experimental.
	useEffect(() => {
		if (refCodeEditorWidget.current) {
			setCodeEditorWidth(props.width);
			refCodeEditorWidget.current.layout({
				width: props.width,
				height: refCodeEditorWidget.current.getContentHeight()
			});
		}
	}, [props.width]);

	// Render.
	return (
		<div ref={ref} className='console-input'>
			<div ref={refContainer}></div>
		</div>
	);
});
