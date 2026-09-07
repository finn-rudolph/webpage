import json
from pathlib import Path

for path in Path("./pictures").rglob("**/contents.json"):
    with open(path, "r") as file:
        contents = json.loads(file.read())
    print(contents)

    with open("", "w", encoding="utf-8") as file:
        file.write(f"""<!doctype html>
<html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{contents["title"]}</title>

        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
        <link
            href="https://fonts.googleapis.com/css2?family=Cormorant:ital,wght@0,300..700;1,300..700&display=swap"
            rel="stylesheet"
        />

        <link rel="stylesheet" href="base.css" />
        <link rel="stylesheet" href="pictures.css" />
        <link rel="icon" type="image/svg+xml" href="/milkyway.svg" />
    </head>
    <body>
        <main>
        </main>
    </body>
</html>
""")
