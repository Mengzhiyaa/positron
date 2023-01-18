/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Posit Software, PBC.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from 'vs/base/common/uuid';

/**
 * ReplLine interface.
 */
interface ReplLine {
	key: string;
	text: string;
}

/**
 * Splits a text string into lines.
 * @param text The text string to split.
 * @returns An array of the split lines.
 */
export const replLineSplitter = (text: string, prompt?: string): ReplLine[] => {
	const replLines = new Array<ReplLine>();
	text.split('\n').forEach((text, index) => {
		replLines.push({ key: generateUuid(), text: (prompt && !index) ? `${prompt} ${text}` : text });
	});
	return replLines;
};
