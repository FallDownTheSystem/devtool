function adfToText(node) {
	if (!node) return '';
	if (typeof node === 'string') return node;
	if (Array.isArray(node)) return node.map(adfToText).join('');
	if (node.type === 'text') return node.text || '';
	if (node.type === 'hardBreak') return '\n';
	const inner = adfToText(node.content);
	const blockTypes = new Set(['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'codeBlock', 'blockquote']);
	if (blockTypes.has(node.type)) return inner + '\n';
	return inner;
}

// Jira Cloud REST v3 returns rich text as Atlassian Document Format, Jira Server as a string.
export function richText(field) {
	if (!field) return '';
	if (typeof field === 'string') return field;
	return adfToText(field).trim();
}

function blocks(text) {
	return text.replace(/\r\n?/g, '\n').split(/\n{2,}/).filter((block) => block.trim());
}

// Plain text maps to one paragraph per blank-line-separated block, with hard breaks for single
// newlines; ADF forbids empty text nodes.
export function textToAdf(text) {
	return {
		type: 'doc',
		version: 1,
		content: blocks(text).map((block) => ({
			type: 'paragraph',
			content: block.split('\n').flatMap((line, i) => [
				...(i ? [{ type: 'hardBreak' }] : []),
				...(line ? [{ type: 'text', text: line }] : []),
			]),
		})),
	};
}

export function storageToText(html) {
	if (!html) return '';
	return html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/p>/gi, '\n')
		.replace(/<\/li>/gi, '\n')
		.replace(/<\/h[1-6]>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function escapeHtml(text) {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Confluence storage format is XHTML, so plain text is escaped and split into paragraphs the same way.
export function textToStorage(text) {
	return blocks(text).map((block) => `<p>${block.split('\n').map(escapeHtml).join('<br />')}</p>`).join('');
}
