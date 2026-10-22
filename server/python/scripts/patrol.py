# title: Őrjárat
# description: 10 cm-es lépésekben halad, és a szonárral kerüli az akadályokat.

def run(ctx):
    """Mozgó őrjárat: akadály előtt megfordul."""
    robot = ctx.robot
    step_cm = 10
    safe_mm = 300

    ctx.log(f"őrjárat, lépés {step_cm} cm, akadálytávolság {safe_mm} mm")
    for i in range(10):
        distance = robot.sonar()
        ctx.log(f"{i + 1}. lépés — a szonár {distance} mm")
        if distance is not None and distance < safe_mm:
            ctx.log("akadály közelben — balra fordulok")
            robot.turn(-90)
            ctx.wait(0.3)
            distance = robot.sonar()
            if distance is not None and distance < safe_mm:
                ctx.log("még mindig akadály — visszafelé")
                robot.backward(step_cm)
                continue
        robot.forward(step_cm)
        ctx.wait(0.2)
    ctx.log("őrjárat vége")
