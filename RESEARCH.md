# Investigación de compatibilidad y latencia

Fecha de la investigación: 20 de octubre de 2026.

## Restricciones verificadas

- Obsidian documenta que un plugin móvil no debe depender de `fs`, `path`, Electron ni de `FileSystemAdapter`; en iOS el adaptador es Capacitor. Inkpad usa exclusivamente `Vault.read`, `Vault.create` y `Vault.modify`.
- La guía oficial recomienda empaquetar el plugin para que `main.js`, `manifest.json` y, si corresponde, `styles.css` queden en el directorio del plugin. Esos tres artefactos están en la raíz del proyecto tras `npm run build`.
- Remotely Save sincroniza los archivos del vault y puede sincronizar al guardar; también trata los conflictos como archivos enteros. Por eso el diseño usa **un solo archivo final por dibujo**, no fragmentos, bases de datos o archivos temporales que puedan llegar a un dispositivo a medio guardar.

## Decisiones de implementación

1. `PointerEvent.getCoalescedEvents()` consume los puntos que el navegador agrupó entre frames: es especialmente útil para tinta rápida con Pencil. La pantalla se actualiza antes de cualquier operación de vault.
2. El Canvas 2D solicita `desynchronized: true`, usa captura de puntero y CSS `touch-action: none`. No hay framework reactivo en el camino de entrada.
3. Se limita la resolución interna a 2.5× para que iPad no agote memoria de GPU; el documento completo se conserva vectorialmente como puntos y el canvas sólo pinta lo visible.
4. El archivo `*.ink` lleva formato y versión, se valida al abrir y se escribe tras una pausa de 2 s como mínimo. Las escrituras se serializan. La posición y el zoom se guardan por la misma ruta, sin afectar el recorrido de entrada del lápiz.
5. Si se detecta una modificación remota mientras el dibujo tiene cambios locales pendientes, Inkpad no sobrescribe de forma silenciosa: muestra un aviso y exige recargar. Es la opción segura para Remotely Save, que no puede fusionar de forma semántica dos dibujos concurrentes.

## Límites honestos

La latencia final sólo puede medirse en un iPad físico: depende del modelo, la tasa de refresco, la versión de iPadOS y el WebView de Obsidian. Este proyecto elimina trabajo evitable del recorrido del lápiz, pero no puede prometer una cifra de milisegundos sin ese dispositivo.

## Fuentes

- [Lista de control de plugins móviles de Obsidian](https://docs.obsidian.md/oo/plugin)
- [API del Vault de Obsidian](https://docs.obsidian.md/Plugins/Vault)
- [Plantilla oficial de plugin de Obsidian](https://github.com/obsidianmd/obsidian-sample-plugin)
- [Documentación de Remotely Save](https://github.com/rayws/obsidian-plugin-remotely-save)
