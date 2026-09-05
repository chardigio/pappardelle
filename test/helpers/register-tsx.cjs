const {register} = require('tsx/esm/api');

// AVA runs tests in worker threads, where tsx's automatic registration is skipped.
register();
