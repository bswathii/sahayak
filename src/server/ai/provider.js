// ai/provider.js — the model-agnostic AIProvider interface.
// The classroom never imports a vendor SDK directly; it only sees this shape.

export class AIUnavailableError extends Error {
  constructor(reason) {
    super(reason);
    this.code = 'ai_unavailable';
  }
}

/**
 * @typedef {object} AIProvider
 * @property {string} name
 * @property {() => boolean} available
 * @property {(input:{text:string,sourceLang:string,targetLang:string,glossaryHints:Array<{en:string,kn:string}>}) => Promise<string>} translate
 * @property {(input:{evidence:object}) => Promise<{summary:string,suggestedNextInteraction:string}>} summarizeHandoff
 * @property {(input:{evidence:object}) => Promise<Array<{text:string,rationale:string}>>} coachingTips
 */

/** Used when AI is disabled, unconfigured, or the provider is unknown. */
export const nullProvider = {
  name: 'none',
  available: () => false,
  async translate() {
    throw new AIUnavailableError('no AI provider configured');
  },
  async summarizeHandoff() {
    throw new AIUnavailableError('no AI provider configured');
  },
  async coachingTips() {
    throw new AIUnavailableError('no AI provider configured');
  },
};
