function asText(source) {
  if (source == null) return null;
  if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
  return String(source);
}

function patchAsPoll(source) {
  return source.replace(
    /const asPoll = \(input\) => pollSchema\.parse\(\{\s*type: "poll",\s*\.\.\.input\s*\}\);/,
    `const asPoll = (input) => pollSchema.parse({
	type: "poll",
	...input,
	title: (input?.title && String(input.title).trim()) || "Choose your preferred spot:"
});`,
  );
}

function patchPollFromMe(source) {
  const from = `const toPollItem = async (client, pollCache, event, phone, cursor) => {
	cachePollEvent(pollCache, event);
	if (isEventFromCurrentAccount(event, phone)) return {
		cursor,
		id: \`\${event.pollMessageGuid}:poll:\${event.sequence}\`,
		values: []
	};`;
  const to = `const toPollItem = async (client, pollCache, event, phone, cursor) => {
	cachePollEvent(pollCache, event);
	const vote = event.delta?.type === "voted" || event.delta?.type === "unvoted";
	if (isEventFromCurrentAccount(event, phone) && !vote) return {
		cursor,
		id: \`\${event.pollMessageGuid}:poll:\${event.sequence}\`,
		values: []
	};`;
  return source.includes(from) ? source.replace(from, to) : source;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  let source = asText(result.source);
  if (source == null) return result;

  if (url.includes("stream-CwA4L5aB")) source = patchAsPoll(source);
  if (url.includes("@spectrum-ts/imessage") && url.includes("/dist/index.js")) {
    source = patchPollFromMe(source);
  }

  if (source === asText(result.source)) return result;
  return { ...result, source, format: result.format ?? "module" };
}
