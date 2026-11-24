const express = require('express');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db;
let estadoRiego = "RIEGO_OFF";
let ultimaLectura = { humedad: 80.0, temperatura: 21.5, luz: 55, conectado: true };
let ultimoMinutoRegado = "";
let ultimoGuardadoTimestamp = 0;

async function iniciarBaseDatos() {
  db = await open({
    filename: path.join(__dirname, 'invernadero_orquideas.db'),
    driver: sqlite3.Database
  });

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
    VALUES (1, 'Arduino Uno - DHT22 Invernadero (Wokwi Cloud)', 'Wi-Fi', 'Conectado');

    INSERT OR IGNORE INTO configuracion_sistema (id_config, frecuencia_minutos, humedad_optima, temp_min, temp_max)
    VALUES (1, 1, 80.00, 18.00, 24.00);
  `);

  console.log("[BASE DE DATOS] Tablas creadas y conectadas correctamente.");
}

// 1. Recibir lecturas (desde la Web o desde puente local)
app.post('/api/sensores', async (req, res) => {
  try {
    const { humedad, temperatura, luz, guardarHistorial } = req.body;
    ultimaLectura = {
      humedad: Number(humedad),
      temperatura: Number(temperatura),
      luz: Number(luz || 55),
      conectado: true
    };

    const cfg = await db.get('SELECT * FROM configuracion_sistema WHERE id_config = 1') || {
      frecuencia_minutos: 1, humedad_optima: 80, temp_min: 18, temp_max: 24
    };

    const humMin = Number(cfg.humedad_optima) - 10;
    const humMax = Number(cfg.humedad_optima) + 5;
    const fueraDeRango = (
      ultimaLectura.humedad < humMin ||
      ultimaLectura.humedad > humMax ||
      ultimaLectura.temperatura < Number(cfg.temp_min) ||
      ultimaLectura.temperatura > Number(cfg.temp_max)
    );

    // Evaluar guardado automático según frecuencia configurada en BD
    const ahora = Date.now();
    const intervaloMs = Number(cfg.frecuencia_minutos) * 60 * 1000;
    const tocaGuardarAuto = (ahora - ultimoGuardadoTimestamp) >= intervaloMs;

    if (guardarHistorial || tocaGuardarAuto) {
      ultimoGuardadoTimestamp = ahora;
      await db.run(
        'INSERT INTO lecturas_ambientales (id_sensor, humedad_relativa, temperatura, alerta_fuera_rango) VALUES (1, ?, ?, ?)',
        [ultimaLectura.humedad, ultimaLectura.temperatura, fueraDeRango ? 1 : 0]
      );
    }

    res.json({ comando: estadoRiego, fueraDeRango });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Obtener todo el estado para el Dashboard
app.get('/api/dashboard', async (req, res) => {
  try {
    const historial = await db.all('SELECT * FROM lecturas_ambientales ORDER BY fecha_hora DESC LIMIT 40');
    const calendario = await db.get('SELECT * FROM calendario_riego ORDER BY id_calendario DESC LIMIT 1');
    const config = await db.get('SELECT * FROM configuracion_sistema WHERE id_config = 1');

    res.json({
      actual: ultimaLectura,
      historial,
      calendario: calendario || { dias_riego: 'Lunes, Miércoles, Viernes', hora_riego: '08:30:00' },
      config: config || { frecuencia_minutos: 1, humedad_optima: 80, temp_min: 18, temp_max: 24 },
      riego: estadoRiego
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Guardar calendario de riego
app.post('/api/calendario', async (req, res) => {
  try {
    const { dias_riego, hora_riego } = req.body;
    const horaSQL = hora_riego.length === 5 ? `${hora_riego}:00` : hora_riego;
    await db.run(
      'INSERT INTO calendario_riego (dias_riego, hora_riego, notificacion_activa) VALUES (?, ?, 1)',
      [dias_riego, horaSQL]
    );
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. Actualizar frecuencia de guardado
app.post('/api/frecuencia', async (req, res) => {
  try {
    const { frecuencia_minutos } = req.body;
    await db.run('UPDATE configuracion_sistema SET frecuencia_minutos = ? WHERE id_config = 1', [Number(frecuencia_minutos)]);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Control manual de riego
app.post('/api/riego', (req, res) => {
  estadoRiego = req.body.comando;
  res.json({ estadoRiego });
});

// 6. Exportar historial en CSV
app.get('/api/exportar-csv', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM lecturas_ambientales ORDER BY fecha_hora DESC');
    let csv = 'ID,Sensor,Humedad (%),Temperatura (C),Fecha y Hora,Alerta Fuera de Rango\n';
    rows.forEach(r => {
      csv += `${r.id_lectura},${r.id_sensor},${r.humedad_relativa},${r.temperatura},${r.fecha_hora},${r.alerta_fuera_rango ? 'SI' : 'NO'}\n`;
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="historial_orquideas.csv"');
    res.send(csv);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// 7. Limpiar historial de pruebas
app.delete('/api/historial', async (req, res) => {
  try {
    await db.run('DELETE FROM lecturas_ambientales');
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 8. Riego automático programado (Hora de Chile)
setInterval(async () => {
  try {
    if (!db) return;
    const row = await db.get('SELECT * FROM calendario_riego WHERE notificacion_activa = 1 ORDER BY id_calendario DESC LIMIT 1');
    if (!row) return;

    const ahora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Santiago" }));
    const diasSemana = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
    const diaActual = diasSemana[ahora.getDay()];
    const horaActual = ahora.toTimeString().slice(0, 5);
    const horaProgramada = row.hora_riego.toString().slice(0, 5);
    const marcaMinuto = `${diaActual}-${horaActual}`;

    if (row.dias_riego.includes(diaActual) && horaProgramada === horaActual && ultimoMinutoRegado !== marcaMinuto) {
      ultimoMinutoRegado = marcaMinuto;
      estadoRiego = "RIEGO_ON";
      setTimeout(() => { estadoRiego = "RIEGO_OFF"; }, 15000);
    }
  } catch (e) {}
}, 10000);

const PORT = process.env.PORT || 3000;
iniciarBaseDatos().then(() => {
  app.listen(PORT, () => console.log(`Servidor web activo en puerto ${PORT}`));
});