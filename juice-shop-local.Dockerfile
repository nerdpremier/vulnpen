# Build the clean local OWASP Juice Shop checkout without modifying its source.
FROM node:24 AS installer
COPY . /juice-shop
WORKDIR /juice-shop
RUN npm install -g typescript@^6.0.3
# Angular 22 builds the UI but does not produce the stats.json expected by the
# upstream frontend SBOM script. Skip only that broken optional build step.
RUN node -e "const fs = require('node:fs'); const file = 'frontend/package.json'; const pkg = JSON.parse(fs.readFileSync(file)); pkg.scripts.build = 'ng build --configuration production'; fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')"
# Upstream's postinstall builds frontend and emits build/app.js; assert that a
# clean clone produced the server entry point before packaging the image.
RUN npm install --omit=dev
RUN test -s build/app.js
RUN npm dedupe --omit=dev
RUN rm -rf frontend/node_modules frontend/.angular
RUN mkdir -p logs && chown -R 65532 logs
RUN chgrp -R 0 ftp/ frontend/dist/ logs/ data/ i18n/
RUN chmod -R g=u ftp/ frontend/dist/ logs/ data/ i18n/
RUN rm ftp/legal.md || true
RUN rm i18n/*.json || true
RUN npm install -g @cyclonedx/cyclonedx-npm@'^2.0.0||^3.0.0||^4.0.0'
RUN npm run sbom

FROM gcr.io/distroless/nodejs24-debian13
WORKDIR /juice-shop
COPY --from=installer --chown=65532:0 /juice-shop .
USER 65532
EXPOSE 3000
CMD ["/juice-shop/build/app.js"]
