/**
 * The built-in platform profiles (PLAYBOOK Tasks 11.2–11.3), compiled once.
 * The profiles themselves are configuration (config/platforms/*.json); all
 * logic lives in @filler/core. Site-specific knowledge stays here and in
 * those files, never in the scanner, mapper or orchestrator.
 */
import { compileProfiles, type CompiledProfile } from '@filler/core';
import events from '../../../../config/platforms/events.json' with { type: 'json' };
import forms from '../../../../config/platforms/forms.json' with { type: 'json' };
import freelance from '../../../../config/platforms/freelance.json' with { type: 'json' };
import jobs from '../../../../config/platforms/jobs.json' with { type: 'json' };
import personalDetails from '../../../../config/platforms/personal-details.json' with { type: 'json' };
import upwork from '../../../../config/platforms/upwork.json' with { type: 'json' };

export const PROFILE_FILES: readonly unknown[] = [
  upwork,
  freelance,
  jobs,
  forms,
  events,
  personalDetails,
];

let compiled: CompiledProfile[] | undefined;

export function builtInProfiles(): CompiledProfile[] {
  compiled ??= compileProfiles(PROFILE_FILES);
  return compiled;
}
