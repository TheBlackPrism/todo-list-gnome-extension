// A month grid for picking a due date. It is styled with the shell's own
// calendar classes so it matches the calendar in the date menu, and it follows
// the same week-start setting.

import Clutter from 'gi://Clutter';
import GDesktopEnums from 'gi://GDesktopEnums';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as DateUtils from 'resource:///org/gnome/shell/misc/dateUtils.js';

const WEEKS = 6;

function weekStart() {
    const schema = Gio.SettingsSchemaSource.get_default()
        ?.lookup('org.gnome.desktop.calendar', true);
    if (schema?.has_key('week-start-day')) {
        const day = new Gio.Settings({settings_schema: schema}).get_enum('week-start-day');
        if (day !== GDesktopEnums.Weekday.DEFAULT)
            return day % 7;
    }
    return Shell.util_get_week_start();
}

const sameDay = (a, b) => a && b && a.year === b.year && a.month === b.month && a.day === b.day;

export const DatePicker = GObject.registerClass({
    Signals: {
        'date-selected': {
            param_types: [GObject.TYPE_INT, GObject.TYPE_INT, GObject.TYPE_INT],
        },
    },
}, class DatePicker extends St.BoxLayout {
    /**
     * @param {{year: number, month: number, day: number}|null} selected
     */
    constructor(selected) {
        super({
            style_class: 'calendar todo-date-picker',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });
        this._selected = selected;
        this._weekStart = weekStart();
        const today = new Date();
        this._year = selected?.year ?? today.getFullYear();
        this._month = selected?.month ?? today.getMonth() + 1;

        const header = new St.BoxLayout({style_class: 'calendar-month-header'});
        this.add_child(header);
        const back = new St.Button({
            style_class: 'calendar-change-month-back pager-button',
            icon_name: 'pan-start-symbolic',
            accessible_name: _('Previous month'),
            can_focus: true,
        });
        back.connect('clicked', () => this._showMonth(-1));
        this._monthLabel = new St.Label({
            style_class: 'calendar-month-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        const forward = new St.Button({
            style_class: 'calendar-change-month-forward pager-button',
            icon_name: 'pan-end-symbolic',
            accessible_name: _('Next month'),
            can_focus: true,
        });
        forward.connect('clicked', () => this._showMonth(1));
        header.add_child(back);
        header.add_child(this._monthLabel);
        header.add_child(forward);

        const layout = new Clutter.GridLayout();
        const grid = new St.Widget({
            style_class: 'todo-date-picker-grid',
            layout_manager: layout,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(grid);

        // Any week will do for the weekday names; 2024-01-07 is a Sunday.
        for (let column = 0; column < 7; column++) {
            const weekday = new Date(2024, 0, 7 + (this._weekStart + column) % 7);
            layout.attach(new St.Label({
                style_class: 'calendar-day-heading',
                text: DateUtils.formatDateWithCFormatString(weekday, '%a'),
            }), column, 0, 1, 1);
        }

        this._days = [];
        for (let index = 0; index < WEEKS * 7; index++) {
            const button = new St.Button({style_class: 'calendar-day', can_focus: true});
            button.connect('clicked', () => {
                const {year, month, day} = button._date;
                this.emit('date-selected', year, month, day);
            });
            layout.attach(button, index % 7, 1 + Math.floor(index / 7), 1, 1);
            this._days.push(button);
        }

        this._update();
    }

    vfunc_scroll_event(event) {
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.UP)
            this._showMonth(-1);
        else if (direction === Clutter.ScrollDirection.DOWN)
            this._showMonth(1);
        else
            return Clutter.EVENT_PROPAGATE;
        return Clutter.EVENT_STOP;
    }

    /**
     * @param {{year: number, month: number, day: number}|null} selected
     */
    setSelected(selected) {
        this._selected = selected;
        if (selected) {
            this._year = selected.year;
            this._month = selected.month;
        }
        this._update();
    }

    /** Puts key focus on the selected day, or today. */
    focusDay() {
        const button = this._days.find(day => day.has_style_pseudo_class('selected')) ??
            this._days.find(day => day.has_style_class_name('calendar-today')) ??
            this._days[0];
        button.grab_key_focus();
    }

    _showMonth(delta) {
        const date = new Date(this._year, this._month - 1 + delta, 1);
        this._year = date.getFullYear();
        this._month = date.getMonth() + 1;
        this._update();
    }

    _update() {
        const first = new Date(this._year, this._month - 1, 1);
        this._monthLabel.text = DateUtils.formatDateWithCFormatString(first,
            first.getFullYear() === new Date().getFullYear() ? '%OB' : '%OB %Y');

        const now = new Date();
        const today = {year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate()};
        const offset = (first.getDay() - this._weekStart + 7) % 7;
        this._days.forEach((button, index) => {
            const date = new Date(this._year, this._month - 1, 1 - offset + index);
            const value = {year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate()};
            const weekend = date.getDay() === 0 || date.getDay() === 6;
            const classes = ['calendar-day', weekend ? 'calendar-weekend' : 'calendar-weekday'];
            if (value.month !== this._month)
                classes.push('calendar-other-month');
            if (sameDay(value, today))
                classes.push('calendar-today');
            button.style_class = classes.join(' ');
            button.label = DateUtils.formatDateWithCFormatString(date, '%-d');
            button.accessible_name = DateUtils.formatDateWithCFormatString(date, '%A %x');
            button._date = value;
            if (sameDay(value, this._selected))
                button.add_style_pseudo_class('selected');
            else
                button.remove_style_pseudo_class('selected');
        });
    }
});

/** @returns {{year: number, month: number, day: number}} */
export function todayParts(offsetDays = 0) {
    const date = GLib.DateTime.new_now_local().add_days(offsetDays);
    return {year: date.get_year(), month: date.get_month(), day: date.get_day_of_month()};
}
