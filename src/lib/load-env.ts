/**
 * Side-effect module: importing this loads .env.local before anything else
 * reads process.env. Import it FIRST in any standalone script — module
 * initialisation order is what makes this work, so it must precede the imports
 * that construct the database client.
 */
import { config } from './env-file'

config()
