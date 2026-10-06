/**
 * The onboarding setup (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md): the guided questions a new
 * business goes through, from its address to its AI teammate, what each answer sets, the answers kept across
 * devices, and the summary. Browser-safe; the state is read on the server (`onboarding-setup/load.ts`).
 */
export * from './address';
export * from './kinds';
export * from './answers';
export * from './state';
export * from './picks';
export * from './plan';
export * from './summary';
export * from './flow';
export * from './words';
