// MP-008 (R4) — re-declare @testing-library/jest-dom's vitest augmentation
// in-package. The legacy SvelteKit workspace pinned vitest@4.1.6 with its
// own copy of `@testing-library/svelte`'s jest-dom augmentation; that
// declaration followed the legacy vitest's module path, so once the
// legacy package was removed (MP-007) dashboard-next moved to vitest@4.1.8
// and the resolution broke. Declaring the augmentation here (where
// `vitest` resolves to dashboard-next's own instance) restores the
// `toBeInTheDocument` / `toHaveClass` matchers on the `Assertion` type
// without changing dependencies — `@testing-library/jest-dom` is already
// a direct devDep.
//
// The `TestingLibraryMatchers` interface is not reachable via
// `@testing-library/jest-dom/types/matchers` because that path is not in
// the package's `exports` field; the public re-export that surfaces the
// same type is `@testing-library/jest-dom/matchers` (which wraps the
// interface as `matchers.TestingLibraryMatchers<E, R>`).
import type * as jestDomMatchers from "@testing-library/jest-dom/matchers";

declare module "vitest" {
  interface Assertion<T = unknown> extends jestDomMatchers.TestingLibraryMatchers<unknown, T> {
    /** @internal phantom member — silences @typescript-eslint/no-empty-object-type.
     *  Never set or read; this is a module-augmentation interface whose sole
     *  purpose is to merge the jest-dom matchers into vitest's Assertion. */
    readonly __jestDomAugmentationMarker?: never;
  }
  interface AsymmetricMatchersContaining extends jestDomMatchers.TestingLibraryMatchers<
    unknown,
    unknown
  > {
    readonly __jestDomAugmentationMarker?: never;
  }
}
