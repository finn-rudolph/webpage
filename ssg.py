import json
from pathlib import Path

for path in Path("./pictures").rglob("**/contents.json"):
    with open(path, "r") as file:
        contents = json.loads(file.read())

    pics = []
    for pic_description in contents["pictures"]:
        image = f"<img src='{pic_description['file']}'/>"
        if "link" in pic_description:
            image = (
                f"<a href={pic_description['link']}/{pic_description['link']}.html>"
                + image
                + "</a>"
            )

        caption = ""
        if "caption" in pic_description:
            caption += "<p>" + pic_description["caption"] + "</p>"
        if "location" in pic_description:
            caption += (
                "<p>"
                + pic_description["location"]
                + " | "
                + pic_description["date"]
                + "</p>"
            )
        pics.append(
            f'<div class="img-with-caption">\n    {image}\n    {caption}\n</div>'
        )

    pics_str = "\n".join(pics)

    back_link = ""
    if path.parent.name != "pictures":
        back_link = f'<a class="back" href="/{path.parent.parent}/{path.parent.parent.name}.html">&#x21A9; back</a>'

    with open(
        str(path.parent) + "/" + path.parent.name + ".html", "w", encoding="utf-8"
    ) as file:
        file.write(f"""<!doctype html>
<html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{contents["title"]}</title>

        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
        <link
            href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400..700;1,400..700&family=Playfair+Display:ital,wght@0,400..900;1,400..900&display=swap"
            rel="stylesheet"
        />

        <link rel="stylesheet" href="/base.css" />
        <link rel="stylesheet" href="/pictures.css" />
        <link rel="icon" type="image/svg+xml" href="/milkyway.svg" />
    </head>
    <body>
        <main>
            <div class="content">
            <div>
                {back_link}
                <a class="home" href="/index.html">home</a>
                </div>
                <h1>{contents["title"]}</h1>
                <div class="container">
                    {pics_str}
                </div>
            </div>
        </main>
    </body>
</html>
""")
