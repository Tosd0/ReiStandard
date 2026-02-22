/**
 * Adapter Factory
 * ReiStandard SDK v1.1.0
 *
 * Creates a database adapter instance based on the supplied configuration.
 *
 * @typedef {'neon'|'pg'} DriverName
 *
 * @typedef {Object} AdapterConfig
 * @property {DriverName} driver  - Which database driver to use.
 * @property {string}     connectionString - Database connection URL.
 */

/**
 * Create a database adapter.
 *
 * @param {AdapterConfig} config
 * @returns {Promise<import('./interface.js').DbAdapter>}
 */
export async function createAdapter(config) {
  if (!config || !config.driver) {
    throw new Error(
      '[rei-standard-amsg-server] "driver" is required in the db config. ' +
      'Supported drivers: neon, pg'
    );
  }

  if (!config.connectionString) {
    throw new Error(
      '[rei-standard-amsg-server] "connectionString" is required in the db config.'
    );
  }

  switch (config.driver) {
    case 'neon': {
      const { NeonAdapter } = await import('./neon.js');
      return new NeonAdapter(config.connectionString);
    }

    case 'pg': {
      const { PgAdapter } = await import('./pg.js');
      return new PgAdapter(config.connectionString);
    }

    default:
      throw new Error(
        `[rei-standard-amsg-server] Unsupported driver "${config.driver}". ` +
        'Supported drivers: neon, pg'
      );
  }
}
