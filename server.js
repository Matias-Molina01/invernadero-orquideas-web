const express = require('express');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const RANGOS = {
  humedad: { min: 70, max: 85 },
  temperatura: { min: 18, max: 24 },
  luz: { min: 40, max: 70 }
};
const DIAS_SEMANA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const ZONA_HORARIA = 'America/Santiago';

let db;
let estadoRiego = 'RIEGO_OFF';
let ultimaLectura = { humedad: 80, temperatura: 21.5, luz: 55, conectado: true };
let ultimoMinutoRegado = '';
let ultimoGuardadoTimestamp = 0;
let timerApagadoRiego;

function obtenerAlertas(lectura) {
  const alertas = [];
  if (lectura.humedad < RANGOS.humedad.min || lectura.humedad > RANGOS.humedad.max) {
    alertas.push({
      clave: 'humedad',
      mensaje: `Humedad fuera de rango: ${lectura.humedad}% (óptimo ${RANGOS.humedad.min}%-${RANGOS.humedad.max}%)`
    });
  }
  if (lectura.temperatura < RANGOS.temperatura.min || lectura.temperatura > RANGOS.temperatura.max) {
    alertas.push({
      clave: 'temperatura',
      mensaje: `Temperatura fuera de rango: ${lectura.temperatura} °C (óptimo ${RANGOS.temperatura.min}°C-${RANGOS.temperatura.max}°C)`
    });
  }
  if (lectura.luz < RANGOS.luz.min || lectura.luz > RANGOS.luz.max) {
    alertas.push({
      clave: 'luz',
      mensaje: `Iluminación fuera de rango: ${lectura.luz}% (óptimo ${RANGOS.luz.min}%-${RANGOS.luz.max}%)`
    });
  }
  return alertas;
}

async function iniciarBaseDatos() {
  const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'invernadero_orquideas.db');
  db = await open({ filename: databasePath, driver: sqlite3.Database });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS sensores (
      id_sensor INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre_sensor TEXT NOT NULL,
      tipo_conexion TEXT NOT NULL DEFAULT 'Wi-Fi',
      estado_conexion TEXT NOT NULL DEFAULT 'Conectado',
      fecha_registro DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS lecturas_ambientales (
      id_lectura INTEGER PRIMARY KEY AUTOINCREMENT,
      id_sensor INTEGER NOT NULL,
      humedad_relativa REAL NOT NULL,
      temperatura REAL NOT NULL,
      luz REAL NOT NULL DEFAULT 55,
      fecha_hora DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      alerta_fuera_rango INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (id_sensor) REFERENCES sensores(id_sensor) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS calendario_riego (
      id_calendario INTEGER PRIMARY KEY AUTOINCREMENT,
      dias_riego TEXT NOT NULL,
      hora_riego TEXT NOT NULL,
      notificacion_activa INTEGER NOT NULL DEFAULT 1,
      fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS configuracion_sistema (
      id_config INTEGER PRIMARY KEY AUTOINCREMENT,
      frecuencia_minutos REAL NOT NULL DEFAULT 1,
      humedad_optima REAL NOT NULL DEFAULT 80.00,
      temp_min REAL NOT NULL DEFAULT 18.00,
      temp_max REAL NOT NULL DEFAULT 24.00
    );

    INSERT OR IGNORE INTO sensores (id_sensor, nombre_sensor, tipo_conexion, estado_conexion)
    VALUES (1, 'Simulador Web - DHT22 y LDR', 'Web', 'Conectado');

    INSERT OR IGNORE INTO configuracion_sistema (id_config, frecuencia_minutos, humedad_optima, temp_min, temp_max)
    VALUES (1, 1, 80.00, 18.00, 24.00);
  `);

  const columnasLecturas = await db.all('PRAGMA table_info(lecturas_ambientales)');
  if (!columnasLecturas.some(columna => columna.name === 'luz')) {
    await db.exec('ALTER TABLE lecturas_ambientales ADD COLUMN luz REAL NOT NULL DEFAULT 55');
  }

  console.log(`[BASE DE DATOS] Conectada: ${databasePath}`);
}

app.post('/api/sensores', async (req, res) => {
  try {
    const humedad = Number(req.body.humedad);
    const temperatura = Number(req.body.temperatura);
    const luz = Number(req.body.luz);
    if (
      !Number.isFinite(humedad) || humedad < 0 || humedad > 100 ||
      !Number.isFinite(temperatura) || temperatura < -40 || temperatura > 80 ||
      !Number.isFinite(luz) || luz < 0 || luz > 100
    ) {
      return res.status(400).json({ error: 'Lectura inválida. Humedad y luz deben estar entre 0 y 100; temperatura entre -40 y 80 °C.' });
    }

    const lectura = { humedad, temperatura, luz, conectado: true };
    const alertas = obtenerAlertas(lectura);
    const fueraDeRango = alertas.length > 0;
    const config = await db.get('SELECT frecuencia_minutos FROM configuracion_sistema WHERE id_config = 1');
    const frecuenciaMinutos = config ? Number(config.frecuencia_minutos) : 1;
    const ahora = Date.now();
    const intervaloMs = frecuenciaMinutos * 60 * 1000;
    const tocaGuardarAuto = ahora - ultimoGuardadoTimestamp >= intervaloMs;

    if (req.body.guardarHistorial === true || tocaGuardarAuto) {
      await db.run(
        `INSERT INTO lecturas_ambientales
          (id_sensor, humedad_relativa, temperatura, luz, alerta_fuera_rango)
         VALUES (1, ?, ?, ?, ?)`,
        [humedad, temperatura, luz, fueraDeRango ? 1 : 0]
      );
      ultimoGuardadoTimestamp = ahora;
    }

    ultimaLectura = lectura;
    res.json({
      actual: ultimaLectura,
      comando: estadoRiego,
      fueraDeRango,
      alertas
    });
  } catch (error) {
    console.error('[API sensores]', error);
    res.status(500).json({ error: 'No se pudo procesar la lectura de sensores.' });
  }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const historial = await db.all('SELECT * FROM lecturas_ambientales ORDER BY fecha_hora DESC, id_lectura DESC LIMIT 40');
    const calendario = await db.get('SELECT * FROM calendario_riego ORDER BY id_calendario DESC LIMIT 1');
    const config = await db.get('SELECT * FROM configuracion_sistema WHERE id_config = 1');

    res.json({
      actual: ultimaLectura,
      historial,
      calendario: calendario || null,
      config: config || { frecuencia_minutos: 1, humedad_optima: 80, temp_min: 18, temp_max: 24 },
      riego: estadoRiego,
      alertas: obtenerAlertas(ultimaLectura)
    });
  } catch (error) {
    console.error('[API dashboard]', error);
    res.status(500).json({ error: 'No se pudo cargar el dashboard.' });
  }
});

app.post('/api/calendario', async (req, res) => {
  try {
    const diasPermitidos = new Set(DIAS_SEMANA);
    const dias = typeof req.body.dias_riego === 'string'
      ? req.body.dias_riego.split(',').map(dia => dia.trim()).filter(dia => diasPermitidos.has(dia))
      : [];
    const diasUnicos = [...new Set(dias)];
    const horaRiego = req.body.hora_riego;
    if (!diasUnicos.length || typeof horaRiego !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(horaRiego)) {
      return res.status(400).json({ error: 'Selecciona al menos un día válido y una hora en formato HH:MM.' });
    }

    const horaSQL = horaRiego.length === 5 ? `${horaRiego}:00` : horaRiego;
    await db.run(
      'INSERT INTO calendario_riego (dias_riego, hora_riego, notificacion_activa) VALUES (?, ?, 1)',
      [diasUnicos.join(', '), horaSQL]
    );
    res.json({ ok: true, dias_riego: diasUnicos.join(', '), hora_riego: horaSQL });
  } catch (error) {
    console.error('[API calendario]', error);
    res.status(500).json({ error: 'No se pudo guardar el calendario de riego.' });
  }
});

app.post('/api/frecuencia', async (req, res) => {
  try {
    const frecuencia = Number(req.body.frecuencia_minutos);
    if (!Number.isFinite(frecuencia) || frecuencia < 0.25 || frecuencia > 1440) {
      return res.status(400).json({ error: 'La frecuencia debe estar entre 0.25 y 1440 minutos.' });
    }
    await db.run('UPDATE configuracion_sistema SET frecuencia_minutos = ? WHERE id_config = 1', [frecuencia]);
    res.json({ ok: true, frecuencia_minutos: frecuencia });
  } catch (error) {
    console.error('[API frecuencia]', error);
    res.status(500).json({ error: 'No se pudo guardar la frecuencia de registro.' });
  }
});

app.post('/api/riego', (req, res) => {
  const { comando } = req.body;
  if (comando !== 'RIEGO_ON' && comando !== 'RIEGO_OFF') {
    return res.status(400).json({ error: 'Comando de riego inválido.' });
  }

  estadoRiego = comando;
  if (timerApagadoRiego) {
    clearTimeout(timerApagadoRiego);
    timerApagadoRiego = undefined;
  }
  res.json({ estadoRiego });
});

app.get('/api/exportar-csv', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM lecturas_ambientales ORDER BY fecha_hora DESC, id_lectura DESC');
    const csv = [
      'ID,Sensor,Humedad (%),Temperatura (C),Iluminación (%),Fecha y Hora,Alerta Fuera de Rango',
      ...rows.map(row => [
        row.id_lectura,
        row.id_sensor,
        row.humedad_relativa,
        row.temperatura,
        row.luz,
        row.fecha_hora,
        row.alerta_fuera_rango ? 'SI' : 'NO'
      ].join(','))
    ].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="historial_orquideas.csv"');
    res.send(`\uFEFF${csv}`);
  } catch (error) {
    console.error('[API exportar-csv]', error);
    res.status(500).json({ error: 'No se pudo exportar el historial.' });
  }
});

app.delete('/api/historial', async (req, res) => {
  try {
    await db.run('DELETE FROM lecturas_ambientales');
    ultimoGuardadoTimestamp = 0;
    res.json({ ok: true });
  } catch (error) {
    console.error('[API historial]', error);
    res.status(500).json({ error: 'No se pudo limpiar el historial.' });
  }
});

async function revisarCalendarioRiego() {
  const row = await db.get('SELECT * FROM calendario_riego WHERE notificacion_activa = 1 ORDER BY id_calendario DESC LIMIT 1');
  if (!row) return;

  const ahora = new Date();
  const diaCorto = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONA_HORARIA,
    weekday: 'short'
  }).format(ahora);
  const indiceDia = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[diaCorto];
  const diaActual = DIAS_SEMANA[indiceDia];
  const horaPartes = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONA_HORARIA,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(ahora);
  const horaActual = `${horaPartes.find(parte => parte.type === 'hour').value}:${horaPartes.find(parte => parte.type === 'minute').value}`;
  const horaProgramada = row.hora_riego.toString().slice(0, 5);
  const marcaMinuto = `${diaActual}-${horaActual}`;
  const diasProgramados = row.dias_riego.split(',').map(dia => dia.trim());

  if (diasProgramados.includes(diaActual) && horaProgramada === horaActual && ultimoMinutoRegado !== marcaMinuto) {
    ultimoMinutoRegado = marcaMinuto;
    estadoRiego = 'RIEGO_ON';
    if (timerApagadoRiego) clearTimeout(timerApagadoRiego);
    timerApagadoRiego = setTimeout(() => {
      estadoRiego = 'RIEGO_OFF';
      timerApagadoRiego = undefined;
    }, 15000);
  }
}

const PORT = process.env.PORT || 3000;
iniciarBaseDatos()
  .then(() => {
    app.listen(PORT, () => console.log(`Servidor web activo en puerto ${PORT}`));
    setInterval(() => {
      revisarCalendarioRiego().catch(error => console.error('[CALENDARIO DE RIEGO]', error));
    }, 10000);
  })
  .catch(error => {
    console.error('[BASE DE DATOS] No se pudo iniciar el servidor:', error);
    process.exitCode = 1;
  });
