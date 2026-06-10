// Submit handler for the OpenAI skills settings form.
//
// Lives in a plain .ts module (no JSX, no @cinatra-ai/sdk-ui import) so the
// catch contract below is unit-testable under this repo's node-environment
// vitest setup (`src/__tests__/**/*.test.ts`); the form component wires it to
// `useNotify()` and the server action.

type SkillsSettingsNotification = {
  title: string;
  body: string;
  kind: "success" | "error";
};

export type SaveOpenAISkillsSubmitDeps = {
  saveAction: (formData: FormData) => Promise<void>;
  addNotification: (notification: SkillsSettingsNotification) => void;
};

/**
 * `redirect()` inside a server action works by THROWING an error whose
 * `digest` starts with `NEXT_REDIRECT`. `saveOpenAISkillsSettingsAction` ends
 * in `redirect("/configuration/llm")`, so a SUCCESSFUL save rejects the
 * awaited action call on the client. Such errors must be re-thrown — not
 * toasted — so Next.js processes the navigation instead of the user seeing a
 * false "save failed" for a save that succeeded.
 */
export function isNextRedirectError(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null | undefined)?.digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}

export function createSaveOpenAISkillsSubmitHandler({
  saveAction,
  addNotification,
}: SaveOpenAISkillsSubmitDeps): (formData: FormData) => Promise<void> {
  return async function handleSubmit(formData: FormData): Promise<void> {
    try {
      await saveAction(formData);
      addNotification({
        title: "OpenAI skills saved",
        body: "Skill configuration has been updated.",
        kind: "success",
      });
    } catch (error) {
      if (isNextRedirectError(error)) {
        throw error;
      }
      // Never surface the caught error.message: in a Next.js production build
      // a thrown server-action error reaches this catch with its real message
      // replaced by the framework's generic masking blurb, so piping it into
      // the toast shows that blurb instead of useful copy. The friendly,
      // operation-specific copy is unconditional; server-side logging of the
      // real failure is unchanged.
      addNotification({
        title: "OpenAI skills save failed",
        body: "Unable to save OpenAI skills.",
        kind: "error",
      });
    }
  };
}
