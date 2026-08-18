# BPGO Operaciones

Código de producción de `operaciones.bpgo.cl`, preparado para despliegue automático en Cloudflare Pages.

## Cloudflare Pages

- Rama de producción: `main`
- Comando de compilación: vacío
- Directorio de salida: `/`
- El proyecto utiliza Pages Functions mediante `_worker.js`.
- Las variables secretas, el binding D1 `DB` y el binding R2 `EVIDENCE_BUCKET` se administran exclusivamente en Cloudflare.

No se deben guardar tokens, contraseñas ni valores secretos dentro del repositorio.

## Publicación automática

Cada actualización enviada a `main` ejecuta `.github/workflows/deploy-cloudflare.yml` y publica el contenido en el proyecto existente `bpgo-operaciones`.

Secretos requeridos en GitHub Actions:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
