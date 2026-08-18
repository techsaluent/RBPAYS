/*
 * RD Service bridge — captures a fingerprint / iris PID block from a
 * UIDAI-certified Registered Device (Mantra, Morpho/IDEMIA, Startek, etc.)
 * running locally, following the standard RD Service HTTP protocol:
 *   1) discover the service across ports 11100-11120 (method RDSERVICE)
 *   2) CAPTURE with a PidOptions XML -> returns a PidData XML
 * The encrypted PID never touches disk here; it's handed to the caller to
 * post to the backend, which forwards it to the AePS/Aadhaar-Pay switch.
 *
 * Note: browsers treat http://127.0.0.1 as a secure/local origin, so an
 * HTTPS panel can reach it. If a device exposes only HTTPS on localhost we
 * try that too. If capture fails, the message explains what to check.
 */
const RDService = (() => {
  const PORT_START = 11100, PORT_END = 11120;

  function xhr(method, url, body, timeout) {
    return new Promise((resolve, reject) => {
      try {
        const x = new XMLHttpRequest();
        x.open(method, url, true);
        x.timeout = timeout || 12000;
        x.setRequestHeader('Content-Type', 'text/xml');
        x.onreadystatechange = () => {
          if (x.readyState === 4) {
            if (x.status === 200) resolve(x.responseText);
            else reject(new Error('HTTP ' + x.status));
          }
        };
        x.ontimeout = () => reject(new Error('timeout'));
        x.onerror = () => reject(new Error('unreachable'));
        x.send(body || '');
      } catch (e) { reject(e); }
    });
  }

  function parseXml(text) {
    return new DOMParser().parseFromString(text, 'text/xml');
  }

  // Find a running RD service and its CAPTURE path.
  async function discover() {
    for (const scheme of ['http', 'https']) {
      for (let port = PORT_START; port <= PORT_END; port++) {
        const host = `${scheme}://127.0.0.1:${port}`;
        try {
          const res = await xhr('RDSERVICE', host, '', 3000);
          const doc = parseXml(res);
          const rd = doc.querySelector('RDService');
          if (!rd) continue;
          const status = rd.getAttribute('status');
          let capturePath = '/rd/capture';
          doc.querySelectorAll('Interface').forEach((i) => {
            if ((i.getAttribute('id') || '').toUpperCase() === 'CAPTURE') capturePath = i.getAttribute('path') || capturePath;
          });
          const info = rd.getAttribute('info') || '';
          return { host, capturePath, status, info, ready: status === 'READY' };
        } catch (_) { /* try next */ }
      }
    }
    return null;
  }

  function pidOptions(biometricType) {
    const iris = biometricType === 'IIR';
    return `<?xml version="1.0"?>` +
      `<PidOptions ver="1.0">` +
      `<Opts fCount="${iris ? 0 : 1}" fType="2" iCount="${iris ? 1 : 0}" iType="0" pCount="0" ` +
      `format="0" pidVer="2.0" timeout="15000" posh="UNKNOWN" env="P" wadh="" />` +
      `</PidOptions>`;
  }

  // Capture a biometric and return the PID block + device metadata.
  async function capture(biometricType) {
    const svc = await discover();
    if (!svc) {
      throw new Error('No RD service found. Install & start your device driver (Mantra/Morpho/Startek RD Service) and plug in the scanner.');
    }
    if (!svc.ready) throw new Error(`Device not ready (status: ${svc.status}). Open the RD service app and register/activate the device.`);

    const pidXml = await xhr('CAPTURE', svc.host + svc.capturePath, pidOptions(biometricType), 20000);
    const doc = parseXml(pidXml);

    // RD services signal capture errors in the Resp element.
    const resp = doc.querySelector('Resp');
    const errCode = resp && resp.getAttribute('errCode');
    if (errCode && errCode !== '0') {
      const errInfo = (resp.getAttribute('errInfo') || 'Capture failed');
      throw new Error(`Capture error ${errCode}: ${errInfo}`);
    }
    const di = doc.querySelector('DeviceInfo');
    return {
      pid_data: pidXml,
      biometric_type: biometricType,
      device_serial: di ? (di.getAttribute('dc') || '') : '',
      rd_service: di ? `${di.getAttribute('mi') || ''} ${di.getAttribute('rdsId') || ''} v${di.getAttribute('rdsVer') || ''}`.trim() : '',
    };
  }

  return { discover, capture };
})();
