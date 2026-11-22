// Entry point. All logic lives in ./server/.
import { start } from './server/index.js';
import { config } from './server/config.js';

start().then((s) => console.log(`عالم البكلاوه ▸ http://localhost:${s.address().port}  (${config.isProd ? 'production' : 'development'})`));
