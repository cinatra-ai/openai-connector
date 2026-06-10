// OpenAI skills settings form — submit-handler error-notification contract.
//
// In a Next.js production build, a server action that throws has its real
// `Error.message` replaced by the framework's generic masking blurb before it
// reaches the client `catch`. The failure notification must therefore carry
// friendly, operation-specific copy — never the caught `error.message` — or
// production users see the masking paragraph as the toast body.
//
// Additionally, `saveOpenAISkillsSettingsAction` ends in
// `redirect("/configuration/llm")`, which THROWS an error whose `digest`
// starts with `NEXT_REDIRECT` — so a SUCCESSFUL save rejects the awaited
// action call. The handler must re-throw that error (letting Next.js process
// the navigation) instead of toasting a false "save failed".

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSaveOpenAISkillsSubmitHandler,
  isNextRedirectError,
} from "../openai-skills-settings-submit";

// Shape of what the client receives from a rejected server action in a
// production build: an Error instance carrying the masking text instead of
// the original server-side message.
const PROD_MASKED_MESSAGE =
  "An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details.";

// Shape of the error `redirect()` throws inside a server action.
function nextRedirectError(path: string): Error {
  const err = new Error("NEXT_REDIRECT");
  (err as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${path};307;`;
  return err;
}

const addNotification = vi.fn();
const saveAction = vi.fn<(formData: FormData) => Promise<void>>();

beforeEach(() => {
  vi.clearAllMocks();
});

function makeHandler() {
  return createSaveOpenAISkillsSubmitHandler({ saveAction, addNotification });
}

describe("createSaveOpenAISkillsSubmitHandler", () => {
  it("shows the friendly operation-specific notification when the action rejects with a prod-masked Error", async () => {
    saveAction.mockRejectedValueOnce(new Error(PROD_MASKED_MESSAGE));

    await makeHandler()(new FormData());

    expect(addNotification).toHaveBeenCalledTimes(1);
    expect(addNotification).toHaveBeenCalledWith({
      title: "OpenAI skills save failed",
      body: "Unable to save OpenAI skills.",
      kind: "error",
    });
    const { title, body } = addNotification.mock.calls[0][0] as {
      title: string;
      body: string;
    };
    expect(body).not.toContain("omitted in production");
    expect(body).not.toContain(PROD_MASKED_MESSAGE);
    // The title identifies the failed operation (not a bare "Save failed").
    expect(title).not.toBe("Save failed");
  });

  it("shows the friendly notification for non-Error rejections too", async () => {
    saveAction.mockRejectedValueOnce("raw string failure");

    await makeHandler()(new FormData());

    expect(addNotification).toHaveBeenCalledTimes(1);
    expect(addNotification).toHaveBeenCalledWith({
      title: "OpenAI skills save failed",
      body: "Unable to save OpenAI skills.",
      kind: "error",
    });
  });

  it("re-throws NEXT_REDIRECT digest errors (successful save → redirect) without any notification", async () => {
    const redirectErr = nextRedirectError("/configuration/llm");
    saveAction.mockRejectedValueOnce(redirectErr);

    await expect(makeHandler()(new FormData())).rejects.toBe(redirectErr);
    expect(addNotification).not.toHaveBeenCalled();
  });

  it("shows the success notification when the action resolves", async () => {
    saveAction.mockResolvedValueOnce(undefined);

    await makeHandler()(new FormData());

    expect(addNotification).toHaveBeenCalledTimes(1);
    expect(addNotification).toHaveBeenCalledWith({
      title: "OpenAI skills saved",
      body: "Skill configuration has been updated.",
      kind: "success",
    });
  });
});

describe("isNextRedirectError", () => {
  it("matches errors whose digest starts with NEXT_REDIRECT", () => {
    expect(isNextRedirectError(nextRedirectError("/configuration/llm"))).toBe(true);
  });

  it("rejects plain errors, non-string digests, and nullish values", () => {
    expect(isNextRedirectError(new Error(PROD_MASKED_MESSAGE))).toBe(false);
    const weirdDigest = new Error("boom");
    (weirdDigest as unknown as { digest: number }).digest = 307;
    expect(isNextRedirectError(weirdDigest)).toBe(false);
    expect(isNextRedirectError(null)).toBe(false);
    expect(isNextRedirectError(undefined)).toBe(false);
    expect(isNextRedirectError("NEXT_REDIRECT")).toBe(false);
  });
});
