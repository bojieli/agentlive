let csrf: string | undefined;
export function setAccountCsrf(value: string | undefined) {
  csrf = value;
}
/** Only same-origin requests without explicit bearer credentials may use browser account authority. */
export const accountFetch: typeof fetch = (input, init) => {
  if (!csrf) return fetch(input, init);
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    location.origin,
  );
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  if (!csrf || url.origin !== location.origin || headers.has("authorization"))
    return fetch(input, init);
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method))
    headers.set("x-csrf-token", csrf);
  return fetch(input, {
    ...init,
    headers,
    credentials: "same-origin",
    redirect: "error",
  });
};
