import { describe, expect, it } from 'vitest';

import { renderNotification, templateDef } from './notification-templates.js';

describe('renderNotification', () => {
  it('renders the appointment reminder, including its SMS body, with vars substituted', () => {
    const rendered = renderNotification('appointmentReminder1Hour', { time: '14:00' });

    expect(rendered.subject).toBe('Your appointment reminder');
    expect(rendered.emailBody).toContain('14:00');
    expect(rendered.smsBody).toContain('14:00');
  });

  it('renders the marketing newsletter with no SMS body — it is not smsEligible', () => {
    const rendered = renderNotification('marketingNewsletter', { headline: 'A headline' });

    expect(rendered.emailBody).toContain('A headline');
    expect(rendered.smsBody).toBeUndefined();
  });

  it('templateDef exposes the registry entry a caller can check smsEligible/category against', () => {
    expect(templateDef('appointmentReminder1Hour').smsEligible).toBe(true);
    expect(templateDef('marketingNewsletter').category).toBe('marketing');
  });
});
