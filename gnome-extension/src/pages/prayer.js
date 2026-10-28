// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 GilangPambudi

// Prayer: today's times as isled has them (Muhammadiyah's KHGT service), the next one counted down, and
// `prayer-alert` before and at each, also while the page is closed. No tab while off or before the
// times are known.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import * as Format from '../format.js';
import {LevelBar, label} from '../widgets.js';
import {Page} from './page.js';

/** Every time the service gives, in the day's order, and whether it is one of the five prayers. */
const TIMES = [
    ['imsak', 'Imsak', false],
    ['subuh', 'Subuh', true],
    ['terbit', 'Terbit', false],
    ['dhuha', 'Dhuha', false],
    ['dzuhur', 'Dzuhur', true],
    ['ashar', 'Ashar', true],
    ['maghrib', 'Maghrib', true],
    ['isya', 'Isya', true],
];
/** The ones the page lists and counts down to, as MASA does. */
const SHOWN = new Set(['subuh', 'terbit', 'dzuhur', 'ashar', 'maghrib', 'isya']);
/** An alert's wait is cut into naps this long at most: a sleeping computer stops the time-outs' clock. */
const ALERT_NAP_MS = 30 * 1000;
/** Woken later than this past a time (the computer slept), its alert is left out. */
const LATE_MS = 60 * 1000;
const BAR_WIDTH = 180;
/** The alerts already given, by time and kind; kept as the screen locks and Isle starts again. */
const alerted = new Set();

/** "2026-10-28" for `date`, in local time. */
function dayKey(date) {
    return GLib.DateTime.new_from_unix_local(Math.floor(date.getTime() / 1000)).format('%Y-%m-%d');
}

/** "18:38", or "6:38 PM" with a 12-hour clock. */
function timeText(ms) {
    return Format.timeOfDay(GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000)));
}

// Signals: `prayer-alert` (json): {kind: 'soon' or 'now', key, name, prayer, at_ms}; 'soon' comes
// `lead` minutes before one of the five prayers.
export const PrayerPage = GObject.registerClass({
    Signals: {'prayer-alert': {param_types: [GObject.TYPE_STRING]}},
}, class PrayerPage extends Page {
    /** The next time and its countdown on top, the day's times in a row below. */
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-prayer',
            layout_manager: new Clutter.BinLayout(),
            height,
        });
        this.name = 'prayer';
        this._enabled = false;
        this._leadMs = 0;
        this._city = '';

        const column = new St.BoxLayout({...VERTICAL, style_class: 'isle-prayer-content', x_expand: true, y_expand: true});
        const top = new St.BoxLayout({x_expand: true, y_expand: true});
        const next = new St.BoxLayout({...VERTICAL, style_class: 'isle-prayer-next', x_expand: true});
        this._nextLabel = label('', 'isle-prayer-caption', {y_align: Clutter.ActorAlign.START});
        this._countdown = label('', 'isle-prayer-countdown', {y_align: Clutter.ActorAlign.START});
        this._bar = new LevelBar({width: BAR_WIDTH, styleClass: 'isle-prayer-bar'});
        this._bar.x_align = Clutter.ActorAlign.START;
        next.add_child(this._nextLabel);
        next.add_child(this._countdown);
        next.add_child(this._bar);
        top.add_child(next);
        const place = new St.BoxLayout({...VERTICAL, style_class: 'isle-prayer-place', y_align: Clutter.ActorAlign.START});
        this._cityLabel = label('', 'isle-prayer-city', {x_align: Clutter.ActorAlign.END});
        this._hijri = label('', 'isle-prayer-caption', {x_align: Clutter.ActorAlign.END});
        place.add_child(this._cityLabel);
        place.add_child(this._hijri);
        top.add_child(place);
        column.add_child(top);

        const row = new St.BoxLayout({style_class: 'isle-prayer-times', x_expand: true});
        /** Each listed time's name and time labels, in order. */
        this._cells = TIMES.filter(([key]) => SHOWN.has(key)).map(([key, name]) => {
            const cell = new St.BoxLayout({...VERTICAL, style_class: 'isle-prayer-cell', x_expand: true});
            const nameLabel = label(name, 'isle-prayer-name');
            const timeLabel = label('', 'isle-prayer-time');
            cell.add_child(nameLabel);
            cell.add_child(timeLabel);
            row.add_child(cell);
            return {key, cell, timeLabel};
        });
        column.add_child(row);
        this.add_child(column);

        this.watch(['prayer'], () => {
            this._update();
            this._scheduleAlert();
        });
    }

    /** From Settings: whether it is on, minutes before a prayer to say so (0: not), and the place's name. */
    configure({enabled, lead, city}) {
        this._enabled = enabled;
        this._leadMs = Math.max(0, lead) * 60000;
        this._city = city;
        this._update();
        this._scheduleAlert();
    }

    /** Only while on and with today's times known. */
    get available() {
        return this._enabled && Boolean(this._today());
    }

    /** Today's and tomorrow's times as isled has them. */
    _days() {
        return this._enabled ? this.daemon.state.prayer ?? [] : [];
    }

    _today() {
        const today = dayKey(new Date());
        return this._days().find(day => day.date === today) ?? null;
    }

    /** Every time of both days, soonest first: {key, name, prayer, at}, `at` in ms. */
    _entries() {
        return this._days().flatMap(day => TIMES.map(([key, name, prayer]) => {
            const at = new Date(`${day.date}T${day[key]}:00`).getTime();
            return {key, name, prayer, at};
        })).filter(entry => !Number.isNaN(entry.at)).sort((a, b) => a.at - b.at);
    }

    onActivate() {
        this._update();
    }

    /** The countdown, the bar and the row, as of now; again each second while on screen. */
    _update() {
        const available = this.available;
        if (available !== this._wasAvailable) {
            this._wasAvailable = available;
            this.emit('availability-changed');
        }
        const today = this._today();
        if (!today)
            return;
        const now = Date.now();
        const listed = this._entries().filter(entry => SHOWN.has(entry.key));
        const next = listed.find(entry => entry.at > now);
        const previous = listed.filter(entry => entry.at <= now).pop();
        if (next) {
            const tomorrow = dayKey(new Date(next.at)) !== today.date;
            this._nextLabel.text = `Next · ${next.name}${tomorrow ? ' tomorrow' : ''} at ${timeText(next.at)}`;
            this._countdown.text = Format.duration(next.at - now);
            // From the time before it (or midnight, before the first), how far the wait has gone.
            const from = previous?.at ?? new Date(`${today.date}T00:00:00`).getTime();
            this._bar.level = (now - from) / Math.max(1, next.at - from);
        } else {
            // Tomorrow's times not known yet (offline): today's are all past.
            this._nextLabel.text = 'Today’s times are over';
            this._countdown.text = '';
            this._bar.level = 1;
        }
        this._cityLabel.text = this._city;
        this._hijri.text = today.hijri;
        for (const {key, cell, timeLabel} of this._cells) {
            const at = new Date(`${today.date}T${today[key]}:00`).getTime();
            timeLabel.text = timeText(at);
            const isNext = next && next.key === key && dayKey(new Date(next.at)) === today.date;
            cell.remove_style_class_name('past');
            cell.remove_style_class_name('next');
            if (isNext)
                cell.add_style_class_name('next');
            else if (at <= now)
                cell.add_style_class_name('past');
        }
        if (this.active)
            this.later('tick', 1000 - (now % 1000), () => this._update());
    }

    /** Waits for the next alert due (a prayer's heads-up or any time itself) and emits `prayer-alert`. */
    _scheduleAlert() {
        this.cancel('alert');
        const now = Date.now();
        // Forget the alerts of times gone by.
        for (const done of alerted) {
            if (Number(done.split('@')[1]) < now - LATE_MS)
                alerted.delete(done);
        }
        const id = (kind, entry) => `${kind}:${entry.key}@${entry.at}`;
        // Still worth saying: a heads-up only before its time, the time itself only just after it.
        const fresh = alert => alert.kind === 'soon' ? alert.at > Date.now() : Date.now() - alert.at < LATE_MS;
        const due = this._entries().flatMap(entry => [
            ...(this._leadMs && entry.prayer ? [{...entry, kind: 'soon', when: entry.at - this._leadMs}] : []),
            {...entry, kind: 'now', when: entry.at},
        ]).filter(alert => !alerted.has(id(alert.kind, alert)) && fresh(alert))
            .sort((a, b) => a.when - b.when)[0];
        if (!due)
            return;
        // Kept while the page is closed: the alerts are for the desktop, not the page.
        this.later('alert', Math.min(Math.max(0, due.when - now), ALERT_NAP_MS), () => {
            // Not yet: after a nap, planned again from the times as they are now.
            if (due.when > Date.now()) {
                this._scheduleAlert();
                return;
            }
            alerted.add(id(due.kind, due));
            if (fresh(due)) {
                this.emit('prayer-alert', JSON.stringify({kind: due.kind, key: due.key, name: due.name,
                    prayer: due.prayer, at_ms: due.at}));
            }
            this._scheduleAlert();
        }, {keep: true});
    }
});
