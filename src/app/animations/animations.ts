import { animate, keyframes, style, transition, trigger } from '@angular/animations';

/***************************************
 * Slide Left → Right (Intro)
 ***************************************/
export const SlideLeftToRightAnimation = {
  slideLeftToRight: trigger('slideLeftToRight', [
    transition(':enter', [
      style({ transform: 'translateX(-100%)' }),
      animate('900ms cubic-bezier(0.4, 0.0, 0.2, 1)', style({ transform: 'translateX(0%)' }))
    ])
  ])
};

/***************************************
 * Scale/Bounce (Quiz transition)
 ***************************************/
export const ChangeRouteAnimation = {
  // `:enter` plays on the initial mount of the anim-host (e.g. Q1's
  // first render); `:increment` / `:decrement` play on numeric
  // transitions between two non-void states. This combination gives
  // a single scale-bounce on Q1 load AND on subsequent navigation,
  // without the double-fire that `* <=> *` produced when URL nav
  // re-mounted the host with idx=0 and then assigned the URL index.
  changeRoute: trigger('changeRoute', [
    transition(':enter, :increment, :decrement', [
      animate(
        '1500ms cubic-bezier(0.4, 0.0, 0.2, 1)',
        keyframes([
          style({ transform: 'scale(1)', offset: 0 }),
          style({ transform: 'scale(1.25)', offset: 0.35 }),
          style({ transform: 'scale(1.35)', offset: 0.55 }),
          style({ transform: 'scale(1)', offset: 1 })
        ])
      )
    ])
  ])
};

/***************************************
 * Correct answer pop-in:
 * Scales from 92% to 100% and fades in over 180ms.
 ***************************************/
export const correctAnswerAnim = trigger('correctAnswer', [
  transition(':enter', [
    style({
      transform: 'scale(0.92)',
      opacity: 0
    }),
    animate(
      '180ms cubic-bezier(0.2, 0.8, 0.2, 1)',
      style({
        transform: 'scale(1)',
        opacity: 1
      })
    )
  ])
]);
