/**
 * Goal templates (PLAYBOOK Task 11.4): a quick way to say what this session
 * is for. Each fills the goal box, role, tone and platform; the user can
 * still edit everything before and after starting.
 */
import type { Goal } from '@filler/core';

export interface GoalTemplate {
  id: string;
  label: string;
  /** Blanks the user fills in, e.g. the role. */
  inputs: Array<{ id: string; label: string; placeholder: string }>;
  build(values: Record<string, string>): Goal;
}

const v = (values: Record<string, string>, id: string, fallback: string) =>
  values[id]?.trim() || fallback;

export const GOAL_TEMPLATES: GoalTemplate[] = [
  {
    id: 'upwork',
    label: 'Upwork profile: <role>',
    inputs: [{ id: 'role', label: 'Your role', placeholder: 'Business consultant' }],
    build: (x) => ({
      text: `Create my Upwork profile as a ${v(x, 'role', 'freelancer')}`,
      role: v(x, 'role', 'freelancer'),
      platform: 'Upwork',
      tone: 'professional',
    }),
  },
  {
    id: 'fiverr',
    label: 'Fiverr gig: <service>',
    inputs: [{ id: 'service', label: 'Your service', placeholder: 'Logo design' }],
    build: (x) => ({
      text: `Create a Fiverr gig for ${v(x, 'service', 'my service')}`,
      role: `${v(x, 'service', 'service')} provider`,
      platform: 'Fiverr',
      tone: 'friendly',
      targetAudience: 'Fiverr buyers',
    }),
  },
  {
    id: 'job',
    label: 'Job application: <role> at <company>',
    inputs: [
      { id: 'role', label: 'Role', placeholder: 'Business Analyst Intern' },
      { id: 'company', label: 'Company', placeholder: 'Acme' },
    ],
    build: (x) => ({
      text: `Apply for the ${v(x, 'role', 'open')} role at ${v(x, 'company', 'the company')}`,
      role: v(x, 'role', 'candidate'),
      tone: 'professional',
      targetAudience: `${v(x, 'company', 'the company')} hiring team`,
    }),
  },
  {
    id: 'govt',
    label: 'College/Govt form: personal details only',
    inputs: [],
    build: () => ({
      text: 'Fill my personal details only on a college or government form',
      tone: 'formal',
    }),
  },
  {
    id: 'event',
    label: 'Hackathon or event registration: <event>',
    inputs: [{ id: 'event', label: 'Event', placeholder: 'Build Weekend 2026' }],
    build: (x) => ({
      text: `Register for ${v(x, 'event', 'the event')}`,
      tone: 'friendly',
      targetAudience: 'event organisers',
    }),
  },
];
