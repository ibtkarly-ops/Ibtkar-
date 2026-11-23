// Gateway types available to the admin panel. The sandbox type exists only outside production.
import { config } from '../config.js';
import plutu from './providers/plutu.js';
import generic from './providers/generic.js';
import sandbox from './providers/sandbox.js';

export const TYPES = { plutu, generic, ...(config.payment.sandbox ? { sandbox } : {}) };
export const catalog = () => Object.values(TYPES).map(({ type, label, description, fields }) => ({ type, label, description, fields }));
