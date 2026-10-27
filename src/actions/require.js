export function requireText(text, what) {
	if (!text?.trim()) throw new Error(`The ${what} is empty. Give the text inline or with --file.`);
}
