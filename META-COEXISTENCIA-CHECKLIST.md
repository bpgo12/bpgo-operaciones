# Meta WhatsApp: preparación de coexistencia

La plataforma queda preparada para vincular el mismo número de WhatsApp Business mediante el registro integrado oficial de Meta. El inicio se mantiene bloqueado hasta que la verificación comercial y la configuración de coexistencia estén completas.

Estado técnico: código previo a la aprobación completado y listo para despliegue automático.

## Configuración pendiente en Cloudflare

Crear estos secretos o variables en el entorno de producción de `bpgo-operaciones`:

- `META_APP_ID`: identificador de la app BPGO COBRANZA.
- `META_APP_SECRET`: secreto de la app; siempre como Secret.
- `META_BUSINESS_ID`: identificador del portafolio comercial de BPGO.
- `META_EMBEDDED_SIGNUP_CONFIG_ID`: identificador de la configuración de registro integrado que se creará después de la aprobación.
- `META_EMBEDDED_SIGNUP_FEATURE`: valor oficial indicado por Meta para el flujo de coexistencia habilitado.
- `WHATSAPP_WEBHOOK_SECRET`: secreto propio para validar el webhook.
- `OPERATIONS_ADMIN_SECRET`: ya existente; se usa además para cifrar la credencial de WhatsApp almacenada en D1.

No reutilizar el Phone Number ID ni el WABA ID anteriores: quedaron obsoletos al retirar el número de Cloud API para instalar WhatsApp Business en el teléfono.

## Después de la aprobación

1. Crear en Meta la configuración de registro integrado con coexistencia.
2. Copiar el Config ID y el modo/feature oficial a Cloudflare.
3. Confirmar que el dominio permitido sea `operaciones.bpgo.cl`.
4. Entrar como superadministrador a Cobranza > WhatsApp API.
5. Presionar **Conectar con Meta** y completar el flujo oficial sin desinstalar WhatsApp Business.
6. Confirmar que el panel muestre el nuevo WABA ID y Phone Number ID.
7. Enviar una prueba controlada a un único teléfono.
8. Responder desde el teléfono y verificar que el mensaje aparezca en la bandeja de la plataforma.
9. Recién después de validar envío, recepción y estados, habilitar campañas masivas.

## Controles incluidos

- La credencial resultante se cifra con AES-GCM antes de guardarse en D1.
- El webhook valida la firma `x-hub-signature-256` cuando `META_APP_SECRET` está configurado.
- Solo un superadministrador puede consultar o completar el registro integrado.
- El flujo no usa identificadores antiguos ni expone tokens en el navegador.
- El botón de conexión permanece deshabilitado mientras falte cualquier configuración obligatoria.

