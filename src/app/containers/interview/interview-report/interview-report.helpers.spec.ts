import type { InterviewSessionConfigViewModel } from '@shared/models/interview/interview-view-models';
import {
  formatReportDate,
  interviewReportTitle,
  reportAssessmentLabel,
  reportDateStamp,
  reportDifficulty,
  reportKindSlug
} from './interview-report.helpers';

const custom = (over: Partial<InterviewSessionConfigViewModel> = {}): InterviewSessionConfigViewModel => ({
  mode: 'custom', difficulty: 'intermediate', topicIds: ['router'], questionCount: 10, ...over
});
const preset = (presetId: string): InterviewSessionConfigViewModel => ({
  mode: 'preset', presetId, topicIds: ['router'], questionCount: 20
});
// A local-noon timestamp: immune to UTC/local day boundaries in any CI timezone.
const LOCAL_NOON = new Date(2026, 8, 26, 12, 0, 0).getTime();

describe('interview report helpers', () => {
  describe('assessment label and difficulty', () => {
    it('names a role preset by its display name', () => {
      expect(reportAssessmentLabel(preset('mid-level'))).toBe('Mid-Level Angular Developer');
    });

    it('calls a custom interview "Custom Interview"', () => {
      expect(reportAssessmentLabel(custom())).toBe('Custom Interview');
    });

    it('shows the chosen difficulty for a custom interview, title-cased', () => {
      expect(reportDifficulty(custom({ difficulty: 'beginner' }))).toBe('Beginner');
    });

    it('shows NO difficulty for a preset (it deliberately mixes them) or when absent', () => {
      expect(reportDifficulty({ ...preset('senior'), difficulty: 'advanced' })).toBe('');
      expect(reportDifficulty(custom({ difficulty: undefined }))).toBe('');
    });
  });

  describe('print title / suggested file name', () => {
    it('uses the first word of the preset name', () => {
      expect(interviewReportTitle(preset('mid-level'), LOCAL_NOON)).toBe('Angular-Interview-Report-Mid-2026-09-26');
      expect(interviewReportTitle(preset('junior'), LOCAL_NOON)).toBe('Angular-Interview-Report-Junior-2026-09-26');
      expect(interviewReportTitle(preset('senior'), LOCAL_NOON)).toBe('Angular-Interview-Report-Senior-2026-09-26');
    });

    it('uses "Custom" for a custom interview', () => {
      expect(interviewReportTitle(custom(), LOCAL_NOON)).toBe('Angular-Interview-Report-Custom-2026-09-26');
    });

    it('falls back to "Preset" for a preset this build does not know — never echoing its id', () => {
      const title = interviewReportTitle(preset('secret-internal-id'), LOCAL_NOON);
      expect(title).toBe('Angular-Interview-Report-Preset-2026-09-26');
      expect(title).not.toContain('secret');
    });

    it('is only letters, digits and hyphens (safe as a file name)', () => {
      for (const cfg of [custom(), preset('junior'), preset('mid-level'), preset('nope')]) {
        expect(interviewReportTitle(cfg, LOCAL_NOON)).toMatch(/^[A-Za-z0-9-]+$/);
      }
    });

    it('takes no session id, token or user identifier — its inputs are config and a date only', () => {
      expect(interviewReportTitle.length).toBe(2);
    });
  });

  describe('dates', () => {
    it('stamps the LOCAL calendar date, zero-padded', () => {
      expect(reportDateStamp(new Date(2026, 0, 5, 9).getTime())).toBe('2026-01-05');
      expect(reportDateStamp(LOCAL_NOON)).toBe('2026-09-26');
    });

    it('formats a long human date for the header', () => {
      expect(formatReportDate(LOCAL_NOON)).toBe('September 26, 2026');
    });
  });

  it('reportKindSlug never returns an empty token', () => {
    expect(reportKindSlug(custom())).toBe('Custom');
    expect(reportKindSlug(preset(''))).toBe('Preset');
  });
});
