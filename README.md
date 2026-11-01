# Peleng Tracker

Неофициальный прототип команды для Space Hackathon with Пеленг 2.0. Приложение объединяет потоки нескольких камер, распознаёт и сопровождает объекты, связывает локальные треки между камерами и при наличии калибровки восстанавливает координаты `(x, y, z)` в метрах.

## Установка

Требуются Python 3.11+, [uv](https://docs.astral.sh/uv/) и Node.js 20+.

```bash
uv sync --extra dev
cd web && npm ci && npm run build && cd ..
```

## Запуск

```bash
uv run peleng-tracker run --config config/hackathon.yaml
```

Dashboard откроется на `http://127.0.0.1:8000`. При первом запуске Ultralytics может скачать выбранные веса. Для запуска vision нажмите соответствующую кнопку API `POST /api/cameras/tracking/start` или используйте Dashboard после подключения потоков.

## Камеры

Скопируйте `config/hackathon.example.yaml` в локальный `config/hackathon.local.yaml` и добавьте камеры. RTSP URL рекомендуется передавать через environment variables:

```yaml
cameras:
  - id: 0
    name: left
    url: ${PELENG_CAMERA_0_URL}
    enabled: true
```

```bash
export PELENG_CAMERA_0_URL='rtsp://camera-host/stream'
uv run peleng-tracker run --config config/hackathon.local.yaml
```

Локальные конфиги, веса и калибровка исключены из Git. Не помещайте логины или пароли в example-файлы.

## Телефон как камера

Встроенный режим не требует мобильного приложения: запустите сервер с доступом из локальной сети, откройте на телефоне `/phone`, разрешите заднюю камеру и нажмите кнопку трансляции. Телефон автоматически появится среди камер и не отключит обычные RTSP/IP-камеры.

Браузерный Camera API работает только в secure context. На другом устройстве это означает HTTPS с сертификатом, которому доверяет телефон. Скопируйте `config/phone.example.yaml`, положите локальный сертификат и ключ в `config/certs/`, затем запустите:

```bash
uv run peleng-tracker run --config config/phone.local.yaml
```

На телефоне откройте `https://IP_НОУТБУКА:8000/phone`. На Dashboard ноутбука нажмите `Start vision`. Для нескольких телефонов задайте разные Camera ID. В режиме без HTTPS можно использовать мобильное приложение, которое публикует RTSP/MJPEG, и подключить его как обычную камеру через `cameras[].url`.

## Смена модели

YOLO26, YOLO11 и custom Ultralytics `.pt` используют один adapter. Измените одну строку и выполните controlled restart из интерфейса или `POST /api/vision/restart`:

```yaml
vision:
  detector:
    weights: yolo11n.pt
```

Новая модель сначала загружается и прогревается. Если проверка завершится ошибкой, активный pipeline останется прежним.

## Калибровка 3D

Скопируйте `config/calibration.example.yaml` в ignored-файл `config/calibration.yaml`, замените параметры каждой камеры и проверьте его:

```bash
uv run peleng-tracker validate-calibration config/calibration.yaml
```

Для 3D нужны синхронные наблюдения минимум с двух откалиброванных камер. Система использует правую систему координат и метры, проверяет положительную глубину и reprojection error. Без калибровки позиция имеет статус `unavailable`; planar fallback работает только при явно заданной homography.

## Демонстрация без камер

Положите два видео в `demo/camera-0.mp4` и `demo/camera-1.mp4`, затем запустите:

```bash
./scripts/offline-demo.sh demo/camera-0.mp4 demo/camera-1.mp4
```

Для измерения inference latency:

```bash
uv run peleng-tracker benchmark --config config/hackathon.yaml --iterations 20
```
