import type { DeepPartial } from '../../types.js'
import type { Dictionary } from '../ru/index.js'

/** Location of forces and equipment: tracking devices, track, settings (ADR-0203). */
export const positions: DeepPartial<Dictionary['positions']> = {
  title: 'Tracking devices',
  hint: 'Vehicle trackers and response team phones: last fix, link and track. Positions come from a monitoring provider with a token or from a team phone in an employee session.',
  create: 'Register device',
  createTitle: 'New tracking device',
  editTitle: 'Device card',
  edit: 'Edit',
  created: 'Device registered',
  saved: 'Card saved',
  search: 'Name or number',
  allSpaces: 'All spaces',
  space: 'Space',
  empty: {
    title: 'No devices yet',
    description:
      'Register a tracker or a team phone — its positions will appear here and on the situation map',
  },
  fields: {
    name: 'Name',
    externalId: 'Device number',
    externalIdHint: 'How the device identifies itself to the provider: IMEI, tracker login',
    kind: 'Kind',
    forcesCode: 'Code in “Forces and equipment”',
    forcesCodeHint: 'The row of the forces register the device belongs to',
    reporter: 'Who sends positions',
    reporterHint:
      'A monitoring provider service account or an employee carrying the team phone: they need no other rights in the space',
    note: 'Note',
    active: 'Accepts positions',
    last: 'Last fix',
    link: 'Link',
    speed: 'Speed',
    battery: 'Battery',
  },
  kinds: {
    vehicle: 'Vehicle',
    team: 'Response team',
    aircraft: 'Aircraft',
    boat: 'Boat',
    person: 'Employee',
    other: 'Other',
  },
  links: {
    online: 'Online',
    stale: 'No link',
    never: 'Never reported',
  },
  states: {
    active: 'Accepting',
    inactive: 'Switched off',
  },
  speedValue: '{value} km/h',
  batteryValue: '{value} %',
  coordinates: '{lat}, {lon}',
  track: {
    title: 'Track for the last day',
    empty: 'No fixes for the last day',
    truncated: 'Showing the last {count} fixes',
    at: 'Time',
    coordinates: 'Coordinates',
  },
  settings: {
    title: 'Location settings',
    open: 'Settings',
    retention: 'Keep fixes for, months',
    retentionHint: 'Months older than this are dropped whole by nightly maintenance',
    stale: '“No link” threshold, minutes',
    staleHint: 'A device without new fixes for longer than this is shown as “no link”',
    dataset: 'Map layer dataset',
    datasetHint:
      'Where the last fix of every device is written once a minute: the “Vehicles and teams” layer of the situation map',
    none: 'Not selected',
    save: 'Save',
    saved: 'Settings saved',
  },
}
