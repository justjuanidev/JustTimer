Generar icono y Release

1) Preparar `logo.png` (fuente)
- Coloca en la raíz del proyecto un PNG cuadrado de alta resolución (p. ej. 1024x1024) llamado `logo.png`.

2) Generar `logo.ico` (local)
- Instala dependencias y genera el `.ico` con este comando:

```powershell
npm install
npm run generate-icon
```

- El script usa `png-to-ico` y producirá `logo.ico` en la raíz.

3) Generar ejecutable

```powershell
npm run build
```

- Esto usará `electron-builder` según `package.json` y generará los instaladores/portables en la carpeta `dist/`.

4) Crear un tag y push para release

```powershell
# etiqueta semver
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

5) Crear release en GitHub
- Opción GUI: Ve a https://github.com/justjuanidev/JustTimer/releases -> "Draft a new release" -> selecciona la etiqueta creada -> sube los instaladores desde `dist/` -> Publica.
- Opción CLI (gh):

```powershell
# con GitHub CLI instalado
gh release create v1.0.0 "dist/*.exe" "dist/*.msi" --title "v1.0.0" --notes "Release JustTimer v1.0.0"
```

6) Qué incluir en el release (artefactos)
- Instalador NSIS (`*.exe`) o instalador portable (`*.zip`/`*.portable.exe`)
- Archivo `logo.ico` si quieres que otros lo descarguen
- CHANGELOG o notas de versión

7) Seguridad / gitignore sugerido
- Ignorar: `node_modules/`, `.env`, `.env.*`, `.electron-user-data/`, `dist/`, `release/`, claves privadas (`*.pem`, `*.key`), artefactos grandes (`*.exe`, `*.msi`).

8) Nota sobre `logo.ico` y tamaños
- Para mejor compatibilidad crea un `logo.png` grande (1024x1024) y genera `logo.ico` que contendrá múltiples resoluciones (16x16, 32x32, 48x48, 256x256).

