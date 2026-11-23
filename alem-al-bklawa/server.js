// Entry point. All logic lives in ./server/.
import { start } from './server/index.js';

start().then((s) => console.log(`عالم البكلاوه ▸ http://localhost:${s.address().port}  (${s.config.isProd ? 'production' : 'development'})`));
