import { Service } from '@angular/core';
import { Howl } from 'howler';

import { SelectedOption } from '../../models/SelectedOption.model';

import { isOptionCorrect } from '../../utils/is-option-correct';

@Service()
export class SoundService {
  // ── properties ──────────────────────────────────────────────────
  private sounds: { [key: string]: Howl } = {};

  /** Selections whose authorized cue has already played. See below. */
  private readonly soundedKeys = new Set<string>();

  // ── constructor / lifecycle ─────────────────────────────────────
  constructor() {
    this.initializeSounds();
  }

  // ── public methods ──────────────────────────────────────────────
  initializeSounds(): void {
    const commonConfig = {
      html5: false,
      format: ['mp3'],
      preload: true
    };

    // Use jsDelivr CDN to serve proper MIME types (audio/mpeg) and CORS headers for GitHub files
    const baseUrl = 'https://cdn.jsdelivr.net/gh/marvinrusinek/angular-22-quiz-app@main/src/assets/sounds';

    this.sounds['correct'] = new Howl({
      src: [`${baseUrl}/correct.mp3`],
      ...commonConfig
    });

    this.sounds['incorrect'] = new Howl({
      src: [`${baseUrl}/incorrect.mp3`],
      ...commonConfig
    });
  }

  /**
   * Play the correct/incorrect cue for ONE authorized selection verdict.
   *
   * ── Why this exists (S5-pre) ───────────────────────────────────────
   *
   * The cue used to play on the click, reading `option.correct` out of the
   * client answer key. That made the sound an ANSWER DISCLOSURE CHANNEL: it
   * told the player whether they were right before any server had said so, and
   * it only worked because the browser held the key.
   *
   * It now plays when the authorized verdict for that selection arrives, which
   * matches what the option painting and icons already do — neutral until
   * authorized, then the truth.
   *
   * `key` identifies one selection (question + option text). A verdict can be
   * re-delivered — a replayed subscription, a revisit re-submitting the same
   * set — so the key is remembered and the cue plays exactly once for it.
   * There is no "unknown" branch on purpose: callers must not call this until
   * they hold `true` or `false`.
   */
  playAuthorizedVerdict(key: string, isCorrect: boolean): void {
    if (!key || this.soundedKeys.has(key)) return;
    this.soundedKeys.add(key);
    this.play(isCorrect ? 'correct' : 'incorrect');
  }

  /** A new run must be able to hear its answers again. */
  resetAuthorizedVerdictSounds(): void {
    this.soundedKeys.clear();
  }

  playOnceForOption(option: SelectedOption): void {
    if (!option.selected) return;

    const soundKey = isOptionCorrect(option) ? 'correct' : 'incorrect';

    this.play(soundKey);
  }

  play(soundName: string): void {
    const sound = this.sounds[soundName];
    if (sound) sound.play();
  }
}