import fs from 'fs';
import path from 'path';

function updatePkg(pkgPath, version, sharedDep) {
  const file = path.resolve(pkgPath);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.version = version;
  if (json.dependencies && json.dependencies['@rei-standard/amsg-shared']) {
    json.dependencies['@rei-standard/amsg-shared'] = sharedDep;
  }
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}

updatePkg('packages/rei-standard-amsg/shared/package.json', '0.2.0', null);
updatePkg('packages/rei-standard-amsg/sw/package.json', '2.3.0', '0.2.0');
updatePkg('packages/rei-standard-amsg/instant/package.json', '0.9.0', '0.2.0');
updatePkg('packages/rei-standard-amsg/client/package.json', '2.4.0', '0.2.0');
updatePkg('packages/rei-standard-amsg/server/package.json', '2.5.0', '0.2.0');
