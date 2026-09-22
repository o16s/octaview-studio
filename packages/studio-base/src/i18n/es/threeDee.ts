// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

export const threeDee = {
  // Común
  color: "Color",
  colorMode: "Modo de color",
  frame: "Marco",
  lineWidth: "Ancho de línea",
  position: "Posición",
  reset: "Restablecer",
  rotation: "Rotación",
  scale: "Escala",
  gradient: "Gradiente",
  type: "Tipo",
  topic: "Tema",

  // Marco
  age: "Antigüedad",
  axisScale: "Escala del eje",
  displayFrame: "Marco de visualización",
  displayFrameHelp:
    "El marco de coordenadas donde se coloca la cámara. La posición y orientación de la cámara serán relativas al origen de este marco.",
  editable: "Editable",
  enablePreloading: "Habilitar precarga",
  fixed: "Fijo",
  followMode: "Modo de seguimiento",
  followModeHelp:
    "Cambie el comportamiento de la cámara durante la reproducción para seguir el marco de visualización o no.",
  frameNotFound: "Marco {{frameId}} no encontrado",
  hideAll: "Ocultar todo",
  historySize: "Tamaño del historial",
  labels: "Etiquetas",
  labelSize: "Tamaño de etiqueta",
  lineColor: "Color de línea",
  noCoordinateFramesFound: "No se encontraron marcos de coordenadas",
  parent: "Padre",
  pose: "Pose",
  rotationOffset: "Desplazamiento de rotación",
  settings: "Configuración",
  showAll: "Mostrar todo",
  transforms: "Transformaciones",
  translation: "Traslación",
  translationOffset: "Desplazamiento de traslación",

  // Escena
  background: "Fondo",
  debugPicking: "Depuración de selección",
  ignoreColladaUpAxis: "Ignorar <up_axis> de COLLADA",
  ignoreColladaUpAxisHelp:
    "Iguale el comportamiento de rviz ignorando la etiqueta <up_axis> en archivos COLLADA",
  labelScale: "Escala de etiqueta",
  labelScaleHelp: "Factor de escala a aplicar a todas las etiquetas",
  meshUpAxis: "Eje superior de malla",
  meshUpAxisHelp:
    'La dirección a usar como "arriba" al cargar mallas sin información de orientación (STL y OBJ)',
  renderStats: "Estadísticas de renderizado",
  scene: "Escena",
  takeEffectAfterReboot: "Esta configuración requiere un reinicio para surtir efecto",
  YUp: "Y-arriba",
  ZUp: "Z-arriba",

  // Cámara
  distance: "Distancia",
  far: "Lejos",
  fovy: "FOV del eje Y",
  near: "Cerca",
  perspective: "Perspectiva",
  phi: "Phi",
  planarProjectionFactor: "Factor de proyección planar",
  syncCamera: "Sincronizar cámara",
  syncCameraHelp:
    "Sincronice la cámara con otros paneles que también tengan esta configuración habilitada.",
  target: "Objetivo",
  theta: "Theta",
  view: "Vista",

  // Temas
  topics: "Temas",

  // Capas personalizadas
  addGrid: "Agregar cuadrícula",
  addURDF: "Agregar URDF",
  customLayers: "Capas personalizadas",
  delete: "Eliminar",
  divisions: "Divisiones",
  grid: "Cuadrícula",
  size: "Tamaño",

  // Anotaciones de imagen
  imageAnnotations: "Anotaciones de imagen",
  resetView: "Restablecer vista",

  // Imágenes
  cameraInfo: "Información de cámara",

  // Cuadrículas de ocupación
  colorModeCustom: "Personalizado",
  colorModeRaw: "Sin procesar",
  colorModeRvizCostmap: "Mapa de costos",
  colorModeRvizMap: "Mapa",
  frameLock: "Bloqueo de marco",
  invalidColor: "Color no válido",
  maxColor: "Color máximo",
  minColor: "Color mínimo",
  unknownColor: "Color desconocido",

  // Utilidades de extensión de punto
  decayTime: "Tiempo de decaimiento",
  decayTimeDefaultZeroSeconds: "0 segundos",
  pointShape: "Forma del punto",
  pointShapeCircle: "Círculo",
  pointShapeSquare: "Cuadrado",
  pointSize: "Tamaño del punto",

  // Modo de color
  colorBy: "Colorear por",
  colorModeBgraPacked: "BGRA (empaquetado)",
  colorModeBgrPacked: "BGR (empaquetado)",
  colorModeColorMap: "Mapa de colores",
  colorModeFlat: "Plano",
  colorModeRgbaSeparateFields: "RGBA (campos separados)",
  ColorFieldComputedDistance: "distancia (auto)",
  flatColor: "Color plano",
  opacity: "Opacidad",
  valueMax: "Valor máximo",
  valueMin: "Valor mínimo",

  // Marcadores
  selectionVariable: "Variable de selección",
  selectionVariableHelp:
    "Al seleccionar un marcador, esta variable global se establecerá con el ID del marcador",
  showOutline: "Mostrar contorno",

  // Poses
  covariance: "Covarianza",
  covarianceColor: "Color de covarianza",
  poseDisplayTypeArrow: "Flecha",
  poseDisplayTypeAxis: "Eje",
  poseDisplayTypeLine: "Línea",

  // Publicar
  publish: "Publicar",
  publishTopicHelp: "El tema en el cual publicar",
  publishTypeHelp: "El tipo de mensaje a publicar al hacer clic en la escena",
  publishTypePoint: "Punto (geometry_msgs/Point)",
  publishTypePose: "Pose (geometry_msgs/PoseStamped)",
  publishTypePoseEstimate: "Estimación de pose (geometry_msgs/PoseWithCovarianceStamped)",
  thetaDeviation: "Desviación de theta",
  thetaDeviationHelp: "La desviación estándar de theta a publicar con las estimaciones de pose",
  xDeviation: "Desviación de X",
  xDeviationHelp: "La desviación estándar de X a publicar con las estimaciones de pose",
  yDeviation: "Desviación de Y",
  yDeviationHelp: "La desviación estándar de Y a publicar con las estimaciones de pose",

  // Elementos HUD y estados vacíos
  noImageTopicsAvailable: "No hay temas de imagen disponibles.",
  imageTopicDNE: "El tema de imagen no existe.",
  calibrationTopicDNE: "El tema de calibración no existe.",
  imageAndCalibrationDNE: "Los temas de imagen y calibración no existen.",
  waitingForCalibrationAndImages: "Esperando mensajes…",
  waitingForCalibration: "Esperando mensajes de calibración…",
  waitingForImages: "Esperando mensajes de imagen…",
  waitingForSyncAnnotations: "Esperando anotaciones sincronizadas…",
};
