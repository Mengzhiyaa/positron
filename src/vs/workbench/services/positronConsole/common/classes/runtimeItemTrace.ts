/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2023 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { RuntimeItem } from 'vs/workbench/services/positronConsole/common/classes/runtimeItem';
import { OutputLine, outputLineSplitter } from 'vs/workbench/services/positronConsole/common/classes/outputLine';

/**
 * RuntimeItemTrace class.
 */
export class RuntimeItemTrace extends RuntimeItem {
	//#region Public Properties

	/**
	 * Gets the timestamp.
	 */
	public readonly timestamp = new Date();

	/**
	 * Gets the output lines.
	 */
	public readonly outputLines: readonly OutputLine[];

	//#endregion Public Properties

	//#region Constructor

	/**
	 * Constructor.
	 * @param id The identifier.
	 * @param text The text.
	 */
	constructor(id: string, text: string) {
		super(id);
		this.outputLines = outputLineSplitter(text);
	}

	//#endregion Constructor
}
