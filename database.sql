CREATE TABLE IF NOT EXISTS sensores (
    id_sensor INT AUTO_INCREMENT PRIMARY KEY,
    nombre_sensor VARCHAR(100) NOT NULL,
    tipo_conexion VARCHAR(20) NOT NULL DEFAULT 'Wi-Fi',
    estado_conexion VARCHAR(20) NOT NULL DEFAULT 'Conectado',
    fecha_registro DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS lecturas_ambientales (
    id_lectura INT AUTO_INCREMENT PRIMARY KEY,
    id_sensor INT NOT NULL,
    humedad_relativa DECIMAL(5,2) NOT NULL,
    temperatura DECIMAL(5,2) NOT NULL,
    fecha_hora DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    alerta_fuera_rango BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT fk_lectura_sensor FOREIGN KEY (id_sensor) 
        REFERENCES sensores(id_sensor) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS calendario_riego (
    id_calendario INT AUTO_INCREMENT PRIMARY KEY,
    dias_riego VARCHAR(100) NOT NULL,
    hora_riego TIME NOT NULL,
    notificacion_activa BOOLEAN NOT NULL DEFAULT TRUE,
    fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS configuracion_sistema (
    id_config INT AUTO_INCREMENT PRIMARY KEY,
    frecuencia_minutos INT NOT NULL DEFAULT 60,
    humedad_optima DECIMAL(5,2) NOT NULL DEFAULT 80.00,
    temp_min DECIMAL(5,2) NOT NULL DEFAULT 18.00,
    temp_max DECIMAL(5,2) NOT NULL DEFAULT 24.00
);

INSERT IGNORE INTO sensores (id_sensor, nombre_sensor, tipo_conexion, estado_conexion)
VALUES (1, 'Arduino Uno - DHT22 Invernadero (Wokwi)', 'Serial/Wi-Fi', 'Conectado');

INSERT IGNORE INTO configuracion_sistema (id_config, frecuencia_minutos, humedad_optima, temp_min, temp_max)
VALUES (1, 60, 80.00, 18.00, 24.00);