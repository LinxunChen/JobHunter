import {createApplication as createBaseApplication} from '../../src/application.mjs';
// Only controlled tests opt into this synthetic document; production defaults off.
export const createApplication=options=>createBaseApplication({initialSettings:{careerDocumentId:'20000101000000-example'},...options});
