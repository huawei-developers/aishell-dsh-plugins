/**
 * The browser-login button's state and the countdown format.
 *
 * The button carries the whole browser route: whether the probe has answered,
 * whether a login is possible here, and whether one is running. Four states in
 * one control is the shape that reads fine and is wrong at the edges, and this
 * package has no component-rendering tier — so the table is pinned here rather
 * than trusted.
 *
 * The states that matter most are the two that keep the button *visible*: a
 * route that cannot run here, and one not yet known. Both are shown rather
 * than hidden, so the person learns the route exists; both are disabled,
 * because pressing them would do nothing.
 */

import { describe, it, expect } from 'vitest'
import { browserButton, formatCountdown } from '../src/client/card-state.ts'

describe('the browser-login button', () => {
  it('says sign in but refuses a press while the probe runs', () => {
    // The label names the action, not the wait: the line above the button says
    // `环境检测中…`, and a button repeating that would report the same fact
    // twice. Disabled rather than hidden, so the person learns the route exists
    // while it is being ruled in or out.
    expect(browserButton('checking', false)).toEqual({
      label: 'form.browser.action',
      disabled: true,
    })
  })

  it('offers the sign-in once the probe passes', () => {
    expect(browserButton('ready', false)).toEqual({
      label: 'form.browser.action',
      disabled: false,
    })
  })

  it('keeps the verb and refuses a press when the route cannot run here', () => {
    // A browser on another machine, or no route to the login service. Shown so
    // the route's existence is not a secret; disabled because it cannot work.
    //
    // The label stays the action's name. The sentence above the button already
    // says the environment does not support this, so a label repeating it would
    // say one thing twice and leave a grey button that no longer names what it
    // would have done.
    expect(browserButton('unsupported', false)).toEqual({
      label: 'form.browser.action',
      disabled: true,
    })
  })

  it('shares one label across every state that is not a login in flight', () => {
    // Checking, ready and unsupported differ only in whether the press is
    // accepted. The line above the button carries the state; the label carries
    // the action, which does not change when the environment refuses it.
    const labels = new Set([
      browserButton('checking', false).label,
      browserButton('ready', false).label,
      browserButton('unsupported', false).label,
    ])
    expect([...labels]).toEqual(['form.browser.action'])
  })

  it('becomes the way out while a login is running', () => {
    // This is what removes the need for a separate waiting page: the same
    // button that started the login ends it.
    expect(browserButton('running', true)).toEqual({
      label: 'form.browser.cancelLabel',
      disabled: false,
    })
  })

  it('shares one label between the checking and the ready states', () => {
    // The state is told apart by whether the button can be pressed and by the
    // line above it (`环境检测中…`), not by its wording — a separate verb for
    // checking would report the same fact twice.
    expect(browserButton('checking', false).label).toBe('form.browser.action')
    expect(browserButton('checking', false).label).toBe(browserButton('ready', false).label)
    // And the two are still distinguishable, which is the whole point of one
    // label serving both.
    expect(browserButton('checking', false).disabled).toBe(true)
    expect(browserButton('ready', false).disabled).toBe(false)
  })

  it('stays pressable while running even if no countdown is shown', () => {
    // A service that reports no `expires_in` leaves the countdown absent but
    // the login running; the exit must not disappear with it.
    expect(browserButton('running', false)).toEqual({
      label: 'form.browser.cancelLabel',
      disabled: false,
    })
  })
})

describe('the countdown', () => {
  it('renders minutes and seconds', () => {
    expect(formatCountdown(600)).toBe('10:00')
    expect(formatCountdown(587)).toBe('9:47')
    expect(formatCountdown(60)).toBe('1:00')
  })

  it('pads the seconds so the width does not change', () => {
    // The figure is drawn with tabular numerals; an unpadded `9:7` would still
    // jump in width as the numbers change.
    expect(formatCountdown(65)).toBe('1:05')
    expect(formatCountdown(9)).toBe('0:09')
  })

  it('reads zero at and past the end', () => {
    expect(formatCountdown(0)).toBe('0:00')
    // A tick that lands a moment late must not render `-0:01`.
    expect(formatCountdown(-3)).toBe('0:00')
  })

  it('truncates a fractional second rather than rounding up', () => {
    // The value comes from a wall-clock difference; rounding up would show a
    // second that has not started.
    expect(formatCountdown(9.9)).toBe('0:09')
  })
})
