// Gateway types available to the admin panel. The sandbox type exists only outside production.
import { rt } from '../runtime.js';
import plutu from './providers/plutu.js';
import generic from './providers/generic.js';
import sandbox from './providers/sandbox.js';

export const types = () => ({ plutu, generic, ...(rt.config.sandbox ? { sandbox } : {}) });
export const catalog = () => Object.values(types()).map(({ type, label, description, fields }) => ({ type, label, description, fields }));
