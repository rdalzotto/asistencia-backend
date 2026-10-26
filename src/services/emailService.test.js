'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { cuentaEnvio } = require('./emailService');

test('con avisos@ cargada sale desde avisos y responde al técnico', () => {
  const c = cuentaEnvio('wott@exitsa.com.ar', { SMTP_USER_AVISOS: 'avisos@exitsa.com.ar', SMTP_PASS_AVISOS: 'x' });
  assert.strictEqual(c.cuenta, 'avisos');
  assert.strictEqual(c.user, 'avisos@exitsa.com.ar');
  assert.strictEqual(c.remitente, 'avisos@exitsa.com.ar');
  assert.strictEqual(c.responderA, 'wott@exitsa.com.ar');
});

test('sin clave de avisos@ no la usa a medias', () => {
  const c = cuentaEnvio('desconocido@exitsa.com.ar', { SMTP_USER_AVISOS: 'avisos@exitsa.com.ar' });
  assert.strictEqual(c, null);
});

test('sin avisos@ ni cuenta personal no hay con qué enviar', () => {
  assert.strictEqual(cuentaEnvio('desconocido@exitsa.com.ar', {}), null);
});
