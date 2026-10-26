// The dialog for adding or editing a to-do.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as ShellEntry from 'resource:///org/gnome/shell/ui/shellEntry.js';

import {composeDue, formatTime, parseTime, splitDue} from '../lib/dates.js';
import {DatePicker, todayParts} from './datePicker.js';
import {formatDay} from './format.js';

const RETURN_KEYS = [Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_ISO_Enter];
const DESCRIPTION_LINES = 4;

/**
 * A click anywhere on the entry focuses its text. The text only takes clicks
 * on what it has drawn (and on 51 none at all while read-only), and St.Entry
 * no longer passes the rest on.
 *
 * @param {St.Entry} entry
 */
function focusOnClick(entry) {
    const text = entry.clutter_text;
    const click = new Clutter.ClickGesture();
    click.connect('recognize', () => {
        if (!text.has_key_focus())
            text.grab_key_focus();
    });
    entry.add_action(click);
}

/**
 * Mutter (50 and 51) updates the input method's cursor when an editable text
 * is first drawn, even if it isn't focused, and that logs criticals. So the
 * entry is editable only while it has key focus. Tab and clicks still reach it.
 *
 * @param {St.Entry} entry
 */
function editableWhileFocused(entry) {
    const text = entry.clutter_text;
    text.editable = false;
    text.connect('key-focus-in', () => {
        text.editable = true;
    });
    text.connect('key-focus-out', () => {
        text.editable = false;
    });
    focusOnClick(entry);
}

export const TodoDialog = GObject.registerClass(
class TodoDialog extends ModalDialog.ModalDialog {
    /**
     * @param {object} params
     * @param {object|null} params.item the to-do to edit, or null for a new one
     * @param {string} [params.initialTitle] title for a new to-do
     * @param {(changed: object, fields: object) => void} params.onSave gets the
     *     fields that differ from what the dialog was opened with, and all fields
     * @param {(() => void)|null} [params.onDelete]
     */
    constructor({item = null, initialTitle = '', onSave, onDelete = null}) {
        super({styleClass: 'todo-dialog'});
        this._onSave = onSave;
        this._original = item
            ? {title: item.title, description: item.description, due: item.due}
            : {title: initialTitle, description: '', due: 0};
        const due = splitDue(this._original.due);
        this._date = due ? {year: due.year, month: due.month, day: due.day} : null;

        const content = new Dialog.MessageDialogContent({
            title: item ? _('Edit To-Do') : _('New To-Do'),
        });
        this.contentLayout.add_child(content);

        this._titleEntry = new St.Entry({
            style_class: 'todo-dialog-entry',
            hint_text: _('Title'),
            text: this._original.title,
            can_focus: true,
            x_expand: true,
        });
        ShellEntry.addContextMenu(this._titleEntry);
        this._titleEntry.clutter_text.connect('text-changed', () => this._validate());
        this._titleEntry.clutter_text.connect('activate', () => this._save());
        content.add_child(this._titleEntry);

        content.add_child(this._buildDueRow(due));

        this._picker = new DatePicker(this._date);
        this._picker.visible = false;
        this._picker.connect('date-selected', (_picker, year, month, day) => {
            this._setDate({year, month, day});
            this._picker.hide();
            this._dateButton.grab_key_focus();
        });
        content.add_child(this._picker);

        content.add_child(this._buildDescription());

        this.addButton({
            label: _('Cancel'),
            action: () => this.close(),
            key: Clutter.KEY_Escape,
        });
        if (onDelete) {
            this.addButton({
                label: _('Delete'),
                action: () => {
                    this.close();
                    onDelete();
                },
            });
        }
        this._saveButton = this.addButton({
            label: item ? _('Save') : _('Add'),
            action: () => this._save(),
            default: true,
        });

        this.setInitialKeyFocus(this._titleEntry);
        this._setDate(this._date);
    }

    _buildDueRow(due) {
        const box = new St.BoxLayout({
            style_class: 'todo-dialog-due',
            orientation: Clutter.Orientation.VERTICAL,
        });

        const row = new St.BoxLayout({style_class: 'todo-dialog-due-row', x_expand: true});
        this._dateButton = new St.Button({
            style_class: 'button todo-dialog-date-button',
            can_focus: true,
            x_expand: true,
        });
        this._dateButton.connect('clicked', () => this._togglePicker());
        this._timeEntry = new St.Entry({
            style_class: 'todo-dialog-entry todo-dialog-time',
            /* Translators: placeholder of the optional due time field */
            hint_text: _('Time'),
            text: due?.time ? formatTime(due.time) : '',
            can_focus: true,
            // Not stretched to the row's height (see the description entry).
            y_align: Clutter.ActorAlign.CENTER,
        });
        editableWhileFocused(this._timeEntry);
        this._timeEntry.clutter_text.connect('text-changed', () => this._validate());
        this._timeEntry.clutter_text.connect('activate', () => this._save());
        this._clearButton = new St.Button({
            style_class: 'button todo-dialog-clear',
            icon_name: 'edit-clear-symbolic',
            accessible_name: _('Remove the due date'),
            can_focus: true,
        });
        this._clearButton.connect('clicked', () => {
            this._setDate(null);
            this._dateButton.grab_key_focus();
        });
        row.add_child(this._dateButton);
        row.add_child(this._timeEntry);
        row.add_child(this._clearButton);
        box.add_child(row);

        const chips = new St.BoxLayout({style_class: 'todo-dialog-chips'});
        for (const [label, days] of [[_('Today'), 0], [_('Tomorrow'), 1], [_('Next week'), 7]]) {
            const chip = new St.Button({style_class: 'button todo-dialog-chip', label, can_focus: true});
            chip.connect('clicked', () => this._setDate(todayParts(days)));
            chips.add_child(chip);
        }
        box.add_child(chips);
        return box;
    }

    _buildDescription() {
        this._descriptionEntry = new St.Entry({
            style_class: 'todo-dialog-entry todo-dialog-description',
            text: this._original.description,
            can_focus: true,
            x_expand: true,
        });
        ShellEntry.addContextMenu(this._descriptionEntry);
        // Most of the box is below or beside the text.
        focusOnClick(this._descriptionEntry);
        const text = this._descriptionEntry.clutter_text;
        text.single_line_mode = false;
        text.line_wrap = true;
        text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;

        // St.Entry centres its text vertically, so the box gets its height
        // from the text itself: room for a few lines, starting at the top.
        text.y_align = Clutter.ActorAlign.START;
        this._descriptionEntry.connect('style-changed', () => {
            const layout = text.get_layout();
            const [, logical] = layout.get_pixel_extents();
            text.min_height = DESCRIPTION_LINES * logical.height / Math.max(1, layout.get_line_count());
        });

        // Return inserts a newline. Mutter 51 no longer does that by itself,
        // and it must not reach the dialog's default button either.
        text.activatable = false;
        const keys = new Clutter.KeyController();
        keys.connect('key-press', () => {
            const [, symbol] = keys.get_key();
            if (!RETURN_KEYS.includes(symbol))
                return Clutter.EVENT_PROPAGATE;
            text.delete_selection();
            text.insert_text('\n', text.get_cursor_position());
            return Clutter.EVENT_STOP;
        });
        text.add_action(keys);

        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        box.add_child(this._descriptionEntry);
        const label = new St.Label({style_class: 'todo-dialog-label', text: _('Description')});
        this._descriptionEntry.label_actor = label;
        this._descriptionScroll = new St.ScrollView({
            style_class: 'todo-dialog-description-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            child: box,
        });
        text.connect('cursor-changed', () => this._keepCursorVisible());

        const section = new St.BoxLayout({
            style_class: 'todo-dialog-section',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        section.add_child(label);
        section.add_child(this._descriptionScroll);
        return section;
    }

    _keepCursorVisible() {
        const text = this._descriptionEntry.clutter_text;
        const cursor = text.get_cursor_rect();
        const top = text.get_allocation_box().y1 + cursor.get_y();
        const bottom = top + cursor.get_height();
        const adjustment = this._descriptionScroll.vadjustment;
        if (top < adjustment.value)
            adjustment.value = top;
        else if (bottom > adjustment.value + adjustment.page_size)
            adjustment.value = bottom - adjustment.page_size;
    }

    _togglePicker() {
        this._picker.visible = !this._picker.visible;
        if (this._picker.visible) {
            this._picker.setSelected(this._date);
            this._picker.focusDay();
        }
    }

    _setDate(date) {
        this._date = date;
        this._dateButton.label = date ? formatDay(date) : _('No due date');
        this._timeEntry.visible = Boolean(date);
        this._clearButton.visible = Boolean(date);
        if (!date)
            this._timeEntry.text = '';
        this._picker.setSelected(date);
        this._validate();
    }

    _currentFields() {
        const time = parseTime(this._timeEntry.text);
        if (time === undefined)
            return null;
        const due = this._date
            ? composeDue(this._date.year, this._date.month, this._date.day, time) : 0;
        return {
            title: this._titleEntry.text.trim(),
            description: this._descriptionEntry.text,
            due,
        };
    }

    _validate() {
        const fields = this._currentFields();
        const timeValid = parseTime(this._timeEntry.text) !== undefined;
        if (timeValid)
            this._timeEntry.remove_style_pseudo_class('error');
        else
            this._timeEntry.add_style_pseudo_class('error');
        const valid = Boolean(fields?.title);
        this._saveButton.reactive = valid;
        this._saveButton.can_focus = valid;
        return valid;
    }

    _save() {
        if (!this._validate())
            return;
        const fields = this._currentFields();
        const changed = Object.fromEntries(Object.entries(fields)
            .filter(([key, value]) => value !== this._original[key]));
        this.close();
        this._onSave(changed, fields);
    }
});
