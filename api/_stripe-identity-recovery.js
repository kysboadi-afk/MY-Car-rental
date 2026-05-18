import { recoverApplicationIdentityFromVeriffDecision } from "./_veriff-identity-recovery.js";

export async function recoverVerifiedApplicationFromStripe(application, options) {
  return recoverApplicationIdentityFromVeriffDecision(application, options);
}
