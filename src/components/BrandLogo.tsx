type BrandLogoProps = {
  className?: string;
  priority?: boolean;
};

export function BrandLogo({ className = "", priority = false }: BrandLogoProps) {
  return (
    <img
      src="/dragnet-social-cropped.jpg"
      alt="Dragnet — automated pull-request code review"
      width={1280}
      height={351}
      className={`block h-auto w-full object-contain ${className}`}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : "auto"}
    />
  );
}
