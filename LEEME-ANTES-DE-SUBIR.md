# BPGO Operaciones con Planta Externa

Paquete preparado desde `bpgo-operaciones-codigo-actual-2026-08-17.zip`.

## Incluye

- Plataforma Operaciones completa recuperada.
- `_worker.js` con autenticación, D1, evidencias y rutas API existentes.
- Nueva tarjeta **Planta Externa** en la pantalla de departamentos.
- BP GIS v1.9 disponible en `/planta-externa/`.
- Botón **← Operaciones** dentro del GIS.

## Publicación segura

1. En Cloudflare, abrir **Workers & Pages → bpgo-operaciones**.
2. Crear primero un nuevo despliegue de vista previa mediante carga directa.
3. Subir el ZIP preparado o el contenido de esta carpeta según lo solicite la interfaz.
4. No crear otro proyecto: debe usarse `bpgo-operaciones` para conservar dominio, D1, R2 y secretos.
5. Probar acceso, Operaciones, Cobranza y Planta Externa.
6. Promover el despliegue a producción únicamente después de esas pruebas.

## Datos del GIS

La primera integración conserva el almacenamiento local del GIS para evitar mezclar su modelo de red con el estado operativo existente. El siguiente paso será crear tablas/API propias para Planta Externa en D1 y migrar los datos exportados del GIS.
