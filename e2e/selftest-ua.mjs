// Tags every request from our own test/probe scripts with a fixed User-Agent so the gateway classifies it as
// caller_kind = "self-test" and keeps it out of the daily summary and dashboard stats (shown as a separate count).
// Import first in any script, or preload a child process with NODE_OPTIONS="--import ./e2e/selftest-ua.mjs".
export const SELFTEST_UA = "glitter-selftest/1";
const orig = globalThis.fetch;
if (!orig.__selftest) {
  const wrapped = (input, init = {}) => {
    const h = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    h.set("user-agent", SELFTEST_UA);
    if (input instanceof Request) return orig(new Request(input, { ...init, headers: h }));
    return orig(input, { ...init, headers: h });
  };
  wrapped.__selftest = true;
  globalThis.fetch = wrapped;
}
