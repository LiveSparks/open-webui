/**
 * Code interpreter result bridge.
 *
 * The pi tool loop runs `execute_code` through the loopback bridge and gets
 * back a flat result object: `{stdout, stderr, result}` (the shape of OWUI's
 * ResultModel). This module is the contract that lets the translator turn
 * those results into the native `open_webui:code_interpreter` item — the
 * "Analyzed" block — with streamed code deltas, stdout, stderr, a result
 * value, and base64 image extraction.
 */

export interface CodeInterpreterResult {
	stdout?: string;
	stderr?: string;
	result?: string;
}

export interface CodeInterpreterImage {
	/** Image format: png, jpeg, webp, etc. */
	type: string;
	/** Base64 payload with no data URI prefix. */
	base64: string;
}

export interface CodeInterpreterItem {
	type: "open_webui:code_interpreter";
	code: string;
	stdout: string;
	stderr: string;
	result: string;
	images: CodeInterpreterImage[];
}

/** Languages whose stdout carries base64 PNG blocks the browser renders. */
const IMAGE_MIME = /^image\/(png|jpeg|webp)$/;

/** Detects a data URI carrying image bytes. */
function dataUriImage(text: string): CodeInterpreterImage | null {
	const match = /data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=\s]+)/.exec(text ?? "");
	if (!match) return null;
	const mime = match[1];
	const payload = match[2];
	if (!mime || !payload) return null;
	if (!IMAGE_MIME.test(mime)) return null;
	return { type: mime.replace("image/", ""), base64: payload.replace(/\s/g, "") };
}

/** Pull base64 image payloads out of the result streams. */
export function extractImages(result: CodeInterpreterResult): CodeInterpreterImage[] {
	const images: CodeInterpreterImage[] = [];
	for (const text of [result.stdout, result.stderr, result.result]) {
		const image = dataUriImage(text ?? "");
		if (image) images.push(image);
	}
	return images;
}

/** Turn a bridged execute_code result into the native item shape. */
export function toCodeInterpreterItem(
	code: string,
	result: CodeInterpreterResult | string,
): CodeInterpreterItem {
	const normalized: CodeInterpreterResult =
		typeof result === "string"
			? { result, stdout: "", stderr: "" }
			: {
					stdout: result.stdout ?? "",
					stderr: result.stderr ?? "",
					result: result.result ?? "",
				};
	return {
		type: "open_webui:code_interpreter",
		code,
		stdout: normalized.stdout ?? "",
		stderr: normalized.stderr ?? "",
		result: normalized.result ?? "",
		images: extractImages(normalized),
	};
}

/**
 * Streaming deltas: the code interpreter streams its code as the model writes
 * it, so the item opens on the first code delta and grows until the run ends.
 * Each delta carries only the new slice; the reducer appends by output index.
 */
export function codeDelta(item: CodeInterpreterItem, delta: string): { code: string } {
	return { code: (item.code ?? "") + delta };
}
