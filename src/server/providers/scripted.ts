import { Effect } from "effect";
import type {
  JevAdapter,
  JevResult,
  MinistralAdapter,
  MinistralResult,
  ProviderError,
} from "./contracts.js";
import { providerFailure } from "./http.js";

export type ScriptedStep<A> =
  | { readonly result: A }
  | { readonly error: ProviderError }
  | { readonly effect: Effect.Effect<A, ProviderError> };

const scripted = <A>(steps: ReadonlyArray<ScriptedStep<A>>) => {
  let index = 0;
  return () => {
    const step = steps[index++];
    if (step === undefined) {
      return Effect.fail(
        providerFailure(
          "provider_error",
          "The deterministic provider script has no remaining response.",
        ),
      );
    }
    if ("result" in step) return Effect.succeed(step.result);
    if ("error" in step) return Effect.fail(step.error);
    return step.effect;
  };
};

export const makeScriptedMinistralAdapter = (
  steps: ReadonlyArray<ScriptedStep<MinistralResult>>,
): MinistralAdapter => ({ complete: scripted(steps) });

export const makeScriptedJevAdapter = (
  steps: ReadonlyArray<ScriptedStep<JevResult>>,
): JevAdapter => ({ decide: scripted(steps) });
