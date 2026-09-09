export const TEXT_PAGE_SIZE = 16384;
function boundary(text: string, offset: number) {
  const position = Math.min(text.length, Math.max(0, offset));
  if (
    position > 0 &&
    position < text.length &&
    text.charCodeAt(position - 1) >= 0xd800 &&
    text.charCodeAt(position - 1) <= 0xdbff &&
    text.charCodeAt(position) >= 0xdc00 &&
    text.charCodeAt(position) <= 0xdfff
  )
    return position - 1;
  return position;
}
export function textPage(text: string, requested: number) {
  if (!Number.isSafeInteger(requested) || requested < 0)
    throw new RangeError("Invalid text page");
  const count = Math.max(1, Math.ceil(text.length / TEXT_PAGE_SIZE));
  const page = Math.min(requested, count - 1);
  const start = boundary(text, page * TEXT_PAGE_SIZE);
  const end = boundary(text, (page + 1) * TEXT_PAGE_SIZE);
  return { page, count, start, end, text: text.slice(start, end) };
}
export function pageContaining(text: string, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length)
    throw new RangeError("Invalid text offset");
  const page = Math.floor(offset / TEXT_PAGE_SIZE);
  return textPage(
    text,
    boundary(text, (page + 1) * TEXT_PAGE_SIZE) <= offset ? page + 1 : page,
  ).page;
}
