# Contribuir a N1nja

🇬🇧 [English version](CONTRIBUTING.md)

¡Gracias por tu interés en contribuir! N1nja es un servidor MCP que detecta queries N+1 de Hibernate/JPA, queries lentas, deadlocks y otros anti-patrones en apps Spring Boot. Toda contribución es bienvenida — reportes de bugs, nuevos detectores, documentación y tests.

## Empezar

```bash
git clone https://github.com/luk-s12/n1nja-mcp.git
cd n1nja-mcp
npm install
npm test
```

Requisitos: Node.js >= 18.

## Flujo de trabajo

1. Hacé un fork del repositorio
2. Creá una branch: `git checkout -b feature/tu-feature`
3. Hacé tus cambios y escribí tests para ellos
4. Asegurate que todos los tests pasen: `npm test`
5. Asegurate que no haya errores de TypeScript: `npm run typecheck`
6. Pasá el linter: `npm run lint`
7. Enviá un pull request contra `main`

### Scripts útiles

| Script | Qué hace |
| --- | --- |
| `npm test` | Corre la suite de tests de Jest |
| `npm run test:watch` | Corre los tests en modo watch |
| `npm run test:coverage` | Corre los tests con reporte de cobertura |
| `npm run typecheck` | Chequea tipos sin emitir (`tsc --noEmit`) |
| `npm run lint` | Pasa el linter en `src` y `tests` |
| `npm run build` | Compila a `dist/` |
| `npm run dev` | Corre el server desde el código con `ts-node` |

## Agregar un nuevo detector

1. Creá `src/core/detection/tu-detector.ts` implementando una función que retorne `TuIssue[]`
2. Agregá el tipo de issue en `src/domain/models/issue.model.ts`
3. Registralo en `src/core/detection/issue-detector.ts`
4. Escribí tests en `tests/detector/`

## Convenciones de código

- Seguí el estilo y las convenciones del código que rodea tu cambio.
- Todo cambio de comportamiento debe venir con tests.
- Mantené los PRs enfocados — un cambio lógico por pull request.
- Los textos visibles al usuario viven en `src/shared/i18n/translations.ts`; actualizá ambos idiomas.
- Los cambios al README hay que aplicarlos en **ambos** `README.md` y `README-ES.md`.

## Reportar bugs

Abrí un issue usando el template **Bug report**. Incluí el input (fragmento de log o código), qué esperabas, qué pasó, y tu entorno (versión de Node, SO, base de datos).

## Proponer features

Abrí un issue usando el template **Feature request** y describí el caso de uso antes de mandar un PR grande.

## Licencia

Al contribuir, aceptás que tus contribuciones se licencien bajo la [Licencia MIT](LICENSE).